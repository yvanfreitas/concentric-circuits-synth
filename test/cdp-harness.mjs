import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const LOOPBACK = "127.0.0.1";
const START_TIMEOUT_MS = 10_000;

class HarnessError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = new.target.name;
  }
}

class BrowserCleanupError extends HarnessError {
  constructor(result) {
    super(`Browser harness cleanup failed: ${Object.values(result.errors).join("; ")}`);
    this.result = result;
  }
}

const errorText = error => error instanceof Error ? error.stack || error.message : String(error);
export const sleep = milliseconds => new Promise(resolveSleep => setTimeout(resolveSleep, milliseconds));

function browserCandidates(environment, platform) {
  if (platform === "win32") {
    return [environment.PROGRAMFILES && join(environment.PROGRAMFILES, "Google/Chrome/Application/chrome.exe"), environment["PROGRAMFILES(X86)"] && join(environment["PROGRAMFILES(X86)"], "Google/Chrome/Application/chrome.exe"), environment.LOCALAPPDATA && join(environment.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe"), environment.PROGRAMFILES && join(environment.PROGRAMFILES, "Microsoft/Edge/Application/msedge.exe"), environment["PROGRAMFILES(X86)"] && join(environment["PROGRAMFILES(X86)"], "Microsoft/Edge/Application/msedge.exe")].filter(Boolean);
  }
  if (platform === "darwin") return ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"];
  return ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium", "/usr/bin/microsoft-edge"];
}

export async function discoverBrowserExecutable(environment = process.env, platform = process.platform) {
  const configured = environment.CHROME_PATH?.trim();
  if (configured && !isAbsolute(configured)) {
    throw new HarnessError("CHROME_PATH must be an absolute path");
  }
  const candidates = configured ? [configured] : browserCandidates(environment, platform);
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      return resolve(candidate);
    } catch (error) {
      if (configured) throw new HarnessError(`CHROME_PATH is not executable: ${configured}`, { cause: error });
    }
  }
  throw new HarnessError(`No supported browser executable found for ${platform}; set CHROME_PATH to an absolute executable path`);
}

export function parseDevToolsActivePort(contents) {
  const [portLine, websocketPath] = contents.trim().split(/\r?\n/);
  const port = Number(portLine);
  if (!Number.isInteger(port) || port < 1 || port > 65_535 || !websocketPath?.startsWith("/")) {
    throw new HarnessError("Chrome wrote an invalid DevToolsActivePort file");
  }
  return { port, browserWebSocketUrl: `ws://${LOOPBACK}:${port}${websocketPath}` };
}

export function createIdempotentCleanup(steps) {
  let cleanupPromise;
  return () => {
    cleanupPromise ??= (async () => {
      const completed = {};
      const errors = {};
      for (const [name, dispose] of [...steps].reverse()) {
        try {
          await dispose();
          completed[name] = true;
        } catch (error) {
          completed[name] = false;
          errors[name] = errorText(error);
        }
      }
      return { complete: Object.keys(errors).length === 0, completed, errors };
    })();
    return cleanupPromise;
  };
}

export async function runWithCleanup(run, cleanup) {
  let value;
  let primaryError;
  try {
    value = await run();
  } catch (error) {
    primaryError = error instanceof Error ? error : new HarnessError(String(error), { cause: error });
  }
  let cleanupResult;
  try {
    cleanupResult = await cleanup();
  } catch (error) {
    cleanupResult = { complete: false, completed: {}, errors: { cleanup: errorText(error) } };
  }
  if (primaryError) {
    Object.defineProperty(primaryError, "harnessCleanup", { value: cleanupResult, enumerable: true });
    throw primaryError;
  }
  if (!cleanupResult.complete) throw new BrowserCleanupError(cleanupResult);
  return { value, cleanup: cleanupResult };
}

function requestJson(url, method = "GET") {
  return new Promise((resolveJson, reject) => {
    const req = request(url, { method }, response => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { body += chunk; });
      response.on("end", () => {
        if (response.statusCode && response.statusCode >= 400) {
          reject(new HarnessError(`${method} ${url} returned ${response.statusCode}: ${body}`));
          return;
        }
        try { resolveJson(JSON.parse(body)); }
        catch (error) { reject(new HarnessError(`Invalid JSON from ${url}`, { cause: error })); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function waitForDevTools(profilePath, browserProcess, diagnostics) {
  const activePortPath = join(profilePath, "DevToolsActivePort");
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try { return parseDevToolsActivePort(await readFile(activePortPath, "utf8")); }
    catch (error) {
      if (browserProcess.exitCode !== null) {
        throw new HarnessError(`Browser exited before CDP started (exit ${browserProcess.exitCode}): ${diagnostics()}`, { cause: error });
      }
      await sleep(50);
    }
  }
  throw new HarnessError(`Timed out waiting for Chrome DevTools: ${diagnostics()}`);
}

function waitForProcessExit(browserProcess, timeoutMs) {
  if (browserProcess.exitCode !== null || browserProcess.signalCode !== null) return Promise.resolve(true);
  return new Promise(resolveExit => {
    const timeout = setTimeout(() => resolveExit(false), timeoutMs);
    browserProcess.once("exit", () => { clearTimeout(timeout); resolveExit(true); });
  });
}

class CdpPage {
  #events = [];
  #nextId = 1;
  #pending = new Map();

  constructor(webSocketDebuggerUrl) {
    this.ws = new WebSocket(webSocketDebuggerUrl);
    this.ready = new Promise((resolveReady, rejectReady) => {
      this.ws.addEventListener("open", resolveReady, { once: true });
      this.ws.addEventListener("error", event => rejectReady(event.error || new HarnessError("CDP WebSocket error")), { once: true });
    });
    this.ws.addEventListener("message", event => this.#handleMessage(event.data));
    this.ws.addEventListener("close", () => {
      for (const pending of this.#pending.values()) pending.reject(new HarnessError(`CDP closed while waiting for ${pending.method}`));
      this.#pending.clear();
    });
  }

  #handleMessage(data) {
    const message = JSON.parse(data);
    if (message.id) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new HarnessError(`${pending.method}: ${message.error.message}`));
      else pending.resolve(message.result);
      return;
    }
    if (message.method === "Runtime.exceptionThrown") this.#events.push({ type: "pageerror", value: message.params.exceptionDetails, raw: message.params });
    if (message.method === "Runtime.consoleAPICalled") this.#events.push({ type: "console", value: { level: message.params.type, text: message.params.args.map(arg => arg.value ?? arg.unserializableValue ?? arg.description ?? arg.type).join(" "), timestamp: message.params.timestamp }, raw: message.params });
    if (message.method === "Log.entryAdded") this.#events.push({ type: "console", value: { level: message.params.entry.level, text: message.params.entry.text, source: message.params.entry.source }, raw: message.params });
  }

  async command(method, params = {}) {
    await this.ready;
    const id = this.#nextId++;
    return new Promise((resolveCommand, reject) => {
      this.#pending.set(id, { method, resolve: resolveCommand, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (result.exceptionDetails) throw new HarnessError(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  }

  drainEvents() { const events = this.#events; this.#events = []; return events; }
  close() { if (this.ws.readyState < WebSocket.CLOSING) this.ws.close(); }
}

export async function waitForCondition(page, expression, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await page.evaluate(expression)) return true; }
    catch (error) { if (!(error instanceof Error)) throw error; }
    await sleep(50);
  }
  return false;
}

export const pageErrors = events => events.filter(event => event.type === "pageerror").map(event => ({ text: event.value.exception?.description || event.value.exception?.value || event.value.text, url: event.value.url, line: event.value.lineNumber, column: event.value.columnNumber }));
export const consoleMessages = events => events.filter(event => event.type === "console").map(event => event.value);

export async function startBrowserHarness(options) {
  const steps = [];
  const cleanup = createIdempotentCleanup(steps);
  try {
    const root = resolve(options.root);
    const html = options.html ?? await readFile(join(root, "index.html"));
    const server = createServer((req, res) => {
      const path = (req.url || "").split("?", 1)[0];
      if (path === "/favicon.ico") { res.writeHead(204); res.end(); return; }
      if (path !== "/index.html") { res.writeHead(404); res.end("not found"); return; }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(html);
    });
    await new Promise((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(0, LOOPBACK, () => { server.off("error", reject); resolveListen(); });
    });
    steps.push(["server", async () => { server.closeAllConnections?.(); await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose())); }]);
    const address = server.address();
    if (!address || typeof address === "string") throw new HarnessError("HTTP server did not expose a TCP port");

    const profilePath = await mkdtemp(join(tmpdir(), "concentric-circuits-synth-browser-"));
    steps.push(["profile", () => rm(profilePath, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })]);
    const executable = await discoverBrowserExecutable();
    const headed = options.headed === true;
    const args = [
      ...(headed ? [] : ["--headless=new"]),
      "--disable-gpu", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
      `--user-data-dir=${profilePath}`, ...(options.chromeArgs || []), "about:blank"
    ];
    const browserProcess = spawn(executable, args, { windowsHide: !headed, stdio: ["ignore", "ignore", "pipe"] });
    let diagnostics = "";
    browserProcess.stderr.on("data", chunk => { diagnostics = `${diagnostics}${chunk}`.slice(-16_384); });
    browserProcess.on("error", error => { diagnostics = `${diagnostics}\n${errorText(error)}`.slice(-16_384); });
    steps.push(["browser", async () => {
      if (await waitForProcessExit(browserProcess, 1_500)) return;
      browserProcess.kill();
      if (!(await waitForProcessExit(browserProcess, 2_000))) throw new HarnessError(`Browser process ${browserProcess.pid} did not exit`);
    }]);
    const devTools = await waitForDevTools(profilePath, browserProcess, () => diagnostics);
    const version = await requestJson(`http://${LOOPBACK}:${devTools.port}/json/version`);
    const target = await requestJson(`http://${LOOPBACK}:${devTools.port}/json/new?about:blank`, "PUT");
    const page = new CdpPage(target.webSocketDebuggerUrl);
    await page.command("Runtime.enable");
    await page.command("Log.enable");
    await page.command("Page.enable");
    steps.push(["page", async () => { try { await page.command("Browser.close"); } finally { page.close(); } }]);
    return { page, origin: `http://${LOOPBACK}:${address.port}`, version, executable, profilePath, debugPort: devTools.port, cleanup };
  } catch (error) {
    const primary = error instanceof Error ? error : new HarnessError(String(error), { cause: error });
    Object.defineProperty(primary, "harnessCleanup", { value: await cleanup(), enumerable: true });
    throw primary;
  }
}

export async function withBrowserHarness(options, run) {
  const harness = await startBrowserHarness(options);
  return runWithCleanup(() => run(harness), harness.cleanup);
}
