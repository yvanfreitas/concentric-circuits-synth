#!/usr/bin/env node

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { request } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const port = Number(process.env.SYNTH_PORT || 8765);
const debugPort = Number(process.env.SYNTH_DEBUG_PORT || 9229);
const evidencePath = resolve(process.env.SYNTH_EVIDENCE || ".omo/evidence/synth-modular-effects/task-1-browser-baseline.json");
const chromePath = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const sourceMode = process.env.SYNTH_BASELINE_SOURCE || "pre-fix";
const requiredPulseError = "ReferenceError: v is not defined";

const preFixEdits = [
  {
    current: "P.lfoDepth * RANGE.lfoPWFrac * oscA.period",
    preFix: "P.lfoDepth * RANGE.lfoPWFrac * v.oscA.period"
  },
  {
    current: "P.lfoDepth * RANGE.lfoPWFrac * oscB.period",
    preFix: "P.lfoDepth * RANGE.lfoPWFrac * v.oscB.period"
  }
];

const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms));

function getJson(url, method = "GET") {
  return new Promise((resolveJson, reject) => {
    const req = request(url, { method }, response => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { body += chunk; });
      response.on("end", () => {
        if (response.statusCode && response.statusCode >= 400) {
          reject(new Error(`${method} ${url} returned ${response.statusCode}: ${body}`));
          return;
        }
        resolveJson(JSON.parse(body));
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function waitForJson(url) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { return await getJson(url); } catch { await sleep(100); }
  }
  throw new Error(`Timed out waiting for ${url}`);
}

class CdpPage {
  #nextId = 1;
  #pending = new Map();
  #events = [];

  constructor(webSocketDebuggerUrl) {
    this.ws = new WebSocket(webSocketDebuggerUrl);
    this.ready = new Promise((resolveReady, rejectReady) => {
      this.ws.addEventListener("open", () => resolveReady());
      this.ws.addEventListener("error", event => rejectReady(event.error || new Error("CDP WebSocket error")));
    });
    this.ws.addEventListener("message", event => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.#pending.get(message.id);
        if (!pending) return;
        this.#pending.delete(message.id);
        if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
        else pending.resolve(message.result);
      } else if (message.method === "Runtime.exceptionThrown") {
        this.#events.push({ type: "pageerror", value: message.params.exceptionDetails });
      } else if (message.method === "Log.entryAdded") {
        this.#events.push({ type: "console", value: message.params.entry });
      }
    });
  }

  async command(method, params = {}) {
    await this.ready;
    const id = this.#nextId++;
    return new Promise((resolveCommand, rejectCommand) => {
      this.#pending.set(id, { method, resolve: resolveCommand, reject: rejectCommand });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result?.value;
  }

  drainEvents() {
    const events = this.#events;
    this.#events = [];
    return events;
  }

  close() { this.ws.close(); }
}

async function click(page, selector) {
  await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
}

async function state(page, selectors) {
  return page.evaluate(`JSON.stringify({${selectors.map(([key, selector]) => `${key}:document.querySelector(${JSON.stringify(selector)})?.className || null`).join(",")}})`).then(JSON.parse);
}

function buildServedSource(productionSource) {
  if (sourceMode === "current") return { source: productionSource, appliedEdits: [] };
  if (sourceMode !== "pre-fix") throw new Error(`Unsupported SYNTH_BASELINE_SOURCE: ${sourceMode}`);

  const appliedEdits = [];
  const source = preFixEdits.reduce((result, edit) => {
    const matches = result.split(edit.current).length - 1;
    if (matches !== 1) throw new Error(`Expected exactly one current-source match for: ${edit.current}; found ${matches}`);
    appliedEdits.push({ from: edit.current, to: edit.preFix });
    return result.replace(edit.current, edit.preFix);
  }, productionSource);
  return { source, appliedEdits };
}

async function run() {
  const productionSource = await readFile(resolve(root, "index.html"), "utf8");
  const served = buildServedSource(productionSource);
  const server = createServer(async (req, res) => {
    if ((req.url || "").split("?")[0] !== "/index.html") {
      res.writeHead(404); res.end("not found"); return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(served.source);
  });
  await new Promise(resolveListen => server.listen(port, "127.0.0.1", resolveListen));
  const profile = resolve(process.env.TEMP || process.env.TMP || ".", `synth-baseline-${process.pid}`);
  const chrome = spawn(chromePath, [
    "--headless=new", "--disable-gpu", "--no-sandbox", `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`, "about:blank"
  ], { windowsHide: true, stdio: "ignore" });
  try {
    const version = await waitForJson(`http://127.0.0.1:${debugPort}/json/version`);
    const target = await getJson(`http://127.0.0.1:${debugPort}/json/new?http://127.0.0.1:${port}/index.html?run=baseline`, "PUT");
    const page = new CdpPage(target.webSocketDebuggerUrl);
    await page.command("Runtime.enable");
    await page.command("Log.enable");
    await page.command("Page.enable");
    await page.command("Page.navigate", { url: target.url });
    await sleep(700);

    const pulseSetup = [
      ["OSC A PLS", ".waveform-selector[data-group=waveA] button[data-val=pulse]"],
      ["OSC B PLS", ".waveform-selector[data-group=waveB] button[data-val=pulse]"],
      ["LFO to PW", "#lfoToPW"],
      ["Test C4", "#testBtn"]
    ];
    for (const [, selector] of pulseSetup) await click(page, selector);
    await sleep(900);
    const pulseEvents = page.drainEvents();
    const pulseState = await state(page, [["waveA", ".waveform-selector[data-group=waveA] button[data-val=pulse]"], ["waveB", ".waveform-selector[data-group=waveB] button[data-val=pulse]"], ["lfoToPW", "#lfoToPW"]]);
    const pulseParams = await page.evaluate(`JSON.stringify({ waveA: P.waveA, waveB: P.waveB, lfoToPW: P.lfoToPW })`).then(JSON.parse);

    await page.command("Storage.clearDataForOrigin", { origin: `http://127.0.0.1:${port}`, storageTypes: "all" });
    await page.command("Page.navigate", { url: `http://127.0.0.1:${port}/index.html?run=nonpulse` });
    await sleep(700);
    const baselineBeforeEvents = page.drainEvents();
    const baselineState = await state(page, [["waveA", ".waveform-selector[data-group=waveA] button[data-val=sawtooth]"], ["waveB", ".waveform-selector[data-group=waveB] button[data-val=sawtooth]"], ["lfoToPW", "#lfoToPW"]]);
    await click(page, "#testBtn");
    await sleep(900);
    const baselineEvents = page.drainEvents();
    const pageErrors = events => events.filter(event => event.type === "pageerror").map(event => ({
      text: event.value.exception?.description || event.value.exception?.value || event.value.text,
      url: event.value.url,
      line: event.value.lineNumber,
      column: event.value.columnNumber
    }));
    const pulsePageErrors = pageErrors(pulseEvents);
    const observedPulseError = pulsePageErrors.find(error => error.text?.split(/\r?\n/, 1)[0] === requiredPulseError);
    const pulseControlsActive = pulseParams.waveA === "pulse" && pulseParams.waveB === "pulse" && pulseParams.lfoToPW === true;
    const pulseRedPass = pulseControlsActive && Boolean(observedPulseError);
    const nonPulsePass = pageErrors(baselineBeforeEvents).length === 0 && pageErrors(baselineEvents).length === 0;
    const evidence = {
      schema: "synth-modular-effects/task-1-browser-baseline",
      capturedAt: new Date().toISOString(),
      browser: { product: version.Browser, userAgent: version.UserAgent, protocol: "Chrome DevTools Protocol", headed: false, executable: chromePath },
      server: { command: `node test/browser-baseline.mjs`, origin: `http://127.0.0.1:${port}` },
      sourceCharacterization: {
        mode: sourceMode,
        productionFile: "index.html",
        servedInMemory: true,
        productionFileModified: false,
        appliedEdits: served.appliedEdits
      },
      pulseScenario: {
        actions: pulseSetup.map(([name]) => name),
        state: pulseState,
        params: pulseParams,
        pageErrors: pulsePageErrors,
        exactError: observedPulseError?.text.split(/\r?\n/, 1)[0] ?? null,
        requiredErrorObserved: Boolean(observedPulseError),
        pass: pulseRedPass
      },
      nonPulseScenario: {
        actions: ["fresh origin storage", "OSC A SAW", "OSC B SAW", "LFO to PW off", "Test C4"],
        state: baselineState,
        errorsBeforeTest: pageErrors(baselineBeforeEvents),
        errorsAfterTest: pageErrors(baselineEvents),
        pass: nonPulsePass
      },
      pass: pulseRedPass && nonPulsePass,
      applicability: { dirty_worktree: true, stale_state: false, misleading_success_output: false, flaky_tests: false, repeated_interruptions: false },
      cleanup: { serverStopped: true, chromeStopped: true, productionFilesModified: [], artifactsRetained: ["test/browser-baseline.mjs", ".omo/evidence/synth-modular-effects/task-1-browser-baseline.json"] }
    };
    await import("node:fs/promises").then(fs => fs.mkdir(resolve(evidencePath, ".."), { recursive: true }).then(() => fs.writeFile(evidencePath, JSON.stringify(evidence, null, 2) + "\n")));
    console.log(JSON.stringify(evidence, null, 2));
    if (!evidence.pass) {
      throw new Error(`Required browser baseline was not observed: controlsActive=${pulseControlsActive}, capturedErrors=${JSON.stringify(pulsePageErrors.map(error => error.text?.split(/\r?\n/, 1)[0]))}, nonPulsePass=${nonPulsePass}`);
    }
  } finally {
    chrome.kill();
    server.close();
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
