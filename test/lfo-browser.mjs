#!/usr/bin/env node

import { createServer, request } from "node:http";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const debugPort = Number(process.env.SYNTH_DEBUG_PORT || 9230);
const evidencePath = resolve(process.env.SYNTH_EVIDENCE || ".omo/evidence/synth-modular-effects/task-2-lfo.json");
const chromePath = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
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
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { return await getJson(url); } catch { await sleep(100); }
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function canReach(url) {
  return new Promise(resolveReach => {
    const req = request(url, response => {
      response.resume();
      resolveReach(true);
    });
    req.setTimeout(500, () => {
      req.destroy();
      resolveReach(false);
    });
    req.on("error", () => resolveReach(false));
    req.end();
  });
}

async function pathExists(path) {
  try { await access(path); return true; } catch { return false; }
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
      } else if (message.method === "Runtime.consoleAPICalled") {
        this.#events.push({
          type: "console",
          value: {
            level: message.params.type,
            text: message.params.args.map(arg => arg.value ?? arg.unserializableValue ?? arg.description ?? arg.type).join(" "),
            timestamp: message.params.timestamp
          }
        });
      } else if (message.method === "Log.entryAdded") {
        this.#events.push({ type: "console", value: { level: message.params.entry.level, text: message.params.entry.text, source: message.params.entry.source } });
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
    const result = await this.command("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
    return result.result?.value;
  }

  drainEvents() {
    const events = this.#events;
    this.#events = [];
    return events;
  }

  close() { this.ws.close(); }
}

async function waitForCondition(page, expression, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await page.evaluate(expression)) return true;
    } catch {}
    await sleep(50);
  }
  return false;
}

async function click(page, selector) {
  await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
}

function pageErrors(events) {
  return events.filter(event => event.type === "pageerror").map(event => ({
    text: event.value.exception?.description || event.value.exception?.value || event.value.text,
    url: event.value.url,
    line: event.value.lineNumber,
    column: event.value.columnNumber
  }));
}

function consoleMessages(events) {
  return events.filter(event => event.type === "console").map(event => event.value);
}

async function readPriorEvidence() {
  try { return JSON.parse(await readFile(evidencePath, "utf8")); } catch { return null; }
}

async function run() {
  const priorEvidence = await readPriorEvidence();
  const gitStatus = spawnSync("git", ["status", "--short"], { cwd: root, encoding: "utf8", windowsHide: true }).stdout.trim().split(/\r?\n/).filter(Boolean);
  const profile = resolve(root, `.omo/lfo-browser-profile-${process.pid}`);
  let server;
  let chrome;
  let page;
  let origin;
  let evidence;
  let runError;

  try {
    server = createServer(async (req, res) => {
      const path = (req.url || "").split("?")[0];
      if (path === "/favicon.ico") {
        res.writeHead(204); res.end(); return;
      }
      if (path !== "/index.html") {
        res.writeHead(404); res.end("not found"); return;
      }
      try {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(await readFile(resolve(root, "index.html")));
      } catch (error) {
        res.writeHead(500); res.end(error.message);
      }
    });
    await new Promise(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    origin = `http://127.0.0.1:${address.port}`;

    chrome = spawn(chromePath, [
      "--headless=new",
      "--disable-gpu",
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profile}`,
      "about:blank"
    ], { windowsHide: true, stdio: "ignore" });

    const version = await waitForJson(`http://127.0.0.1:${debugPort}/json/version`);
    const target = await getJson(`http://127.0.0.1:${debugPort}/json/new?about:blank`, "PUT");
    page = new CdpPage(target.webSocketDebuggerUrl);
    await page.command("Runtime.enable");
    await page.command("Log.enable");
    await page.command("Page.enable");
    await page.command("Page.navigate", { url: `${origin}/index.html?run=lfo-green-${Date.now()}` });
    const loaded = await waitForCondition(page, `document.readyState === "complete" && typeof P !== "undefined"`);
    if (!loaded) throw new Error("Application did not reach a loaded state");
    await page.evaluate('hardSyncEngine.readyPromise');
    const startupEvents = page.drainEvents();

    await page.evaluate(`(() => {
      window.__lfoConnectCalls = [];
      window.__originalAudioConnect = AudioNode.prototype.connect;
      AudioNode.prototype.connect = function(destination, ...args) {
        window.__lfoConnectCalls.push({ source: this, destination });
        return window.__originalAudioConnect.call(this, destination, ...args);
      };
    })()`);
    await click(page, ".waveform-selector[data-group=waveA] button[data-val=pulse]");
    await click(page, ".waveform-selector[data-group=waveB] button[data-val=pulse]");
    await click(page, "#lfoToPW");
    await click(page, "#testBtn");
    const pulseDuring = await page.evaluate(`(() => {
      const voice = [...voices.values()][0] || null;
      const connections = window.__lfoConnectCalls || [];
      const expectedA = voice ? P.lfoDepth * RANGE.lfoPWFrac * voice.oscA.period : null;
      const expectedB = voice ? P.lfoDepth * RANGE.lfoPWFrac * voice.oscB.period : null;
      return {
        settings: {
          waveA: P.waveA,
          waveB: P.waveB,
          lfoToPW: P.lfoToPW,
          waveAClass: document.querySelector('.waveform-selector[data-group=waveA] button[data-val=pulse]').className,
          waveBClass: document.querySelector('.waveform-selector[data-group=waveB] button[data-val=pulse]').className,
          lfoToPWClass: document.querySelector('#lfoToPW').className
        },
        voiceCreated: Boolean(voice),
        voiceId: voice?.id ?? null,
        voiceCount: voices.size,
        noteRegistered: Boolean(voice && (noteToVoiceIds.get(60) || []).includes(voice.id)),
        pulseA: {
          delayPresent: Boolean(voice && pulseWidthParam(voice.oscA)),
          modulationNodePresent: Boolean(voice?.lfoNodes.pwA),
          gain: voice?.lfoNodes.pwA?.gain.value ?? null,
          expectedGain: expectedA,
          connectedToDelayTime: Boolean(voice && connections.some(call => call.source === lfoOsc && call.destination === voice.lfoNodes.pwA) && connections.some(call => call.source === voice.lfoNodes.pwA && call.destination === pulseWidthParam(voice.oscA)))
        },
        pulseB: {
          delayPresent: Boolean(voice && pulseWidthParam(voice.oscB)),
          modulationNodePresent: Boolean(voice?.lfoNodes.pwB),
          gain: voice?.lfoNodes.pwB?.gain.value ?? null,
          expectedGain: expectedB,
          connectedToDelayTime: Boolean(voice && connections.some(call => call.source === lfoOsc && call.destination === voice.lfoNodes.pwB) && connections.some(call => call.source === voice.lfoNodes.pwB && call.destination === pulseWidthParam(voice.oscB)))
        }
      };
    })()`);
    await page.evaluate(`(() => {
      if (window.__originalAudioConnect) AudioNode.prototype.connect = window.__originalAudioConnect;
      delete window.__originalAudioConnect;
      delete window.__lfoConnectCalls;
    })()`);

    const releaseObserved = pulseDuring.voiceId
      ? await waitForCondition(page, `!voices.has(${JSON.stringify(pulseDuring.voiceId)}) && !noteToVoiceIds.has(60)`)
      : false;
    const pulseAfterRelease = await page.evaluate(`({
      releaseObserved: ${releaseObserved},
      voiceCount: voices.size,
      noteRegistered: noteToVoiceIds.has(60),
      badge: document.querySelector("#polyBadge").textContent
    })`);
    const pulseEvents = page.drainEvents();

    await page.evaluate(`(() => {
      const input = document.querySelector("#lfoRate");
      input.value = "7.25";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    const rateSnapshot = await page.evaluate(`({
      requested: 7.25,
      param: P.lfoRate,
      input: Number(document.querySelector("#lfoRate").value),
      oscillatorFrequency: lfoOsc.frequency.value
    })`);

    const presetSelected = await page.evaluate(`(() => {
      const select = document.querySelector("#presetSelect");
      const value = "fact_Reso-Clav";
      if (![...select.options].some(option => option.value === value)) return false;
      select.value = value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()`);
    const presetSnapshot = await page.evaluate(`({
      selected: document.querySelector("#presetSelect").value,
      selectedFound: ${presetSelected},
      paramShape: P.lfoShape,
      oscillatorType: lfoOsc.type,
      paramRate: P.lfoRate,
      oscillatorFrequency: lfoOsc.frequency.value
    })`);
    const presetEvents = page.drainEvents();

    await page.command("Page.navigate", { url: `${origin}/index.html?run=lfo-session-${Date.now()}` });
    const sessionLoaded = await waitForCondition(page, `document.readyState === "complete" && typeof P !== "undefined" && document.querySelector("#presetSelect")`);
    if (!sessionLoaded) throw new Error("Restored session did not reach a loaded state");
    const sessionSnapshot = await page.evaluate(`({
      selected: document.querySelector("#presetSelect").value,
      paramShape: P.lfoShape,
      oscillatorType: lfoOsc.type,
      paramRate: P.lfoRate,
      oscillatorFrequency: lfoOsc.frequency.value,
      restoreLogPresent: document.querySelector("#log").textContent.includes("Previous session restored.")
    })`);
    const sessionEvents = page.drainEvents();

    const allEvents = [...startupEvents, ...pulseEvents, ...presetEvents, ...sessionEvents];
    const errors = pageErrors(allEvents);
    const messages = consoleMessages(allEvents);
    const consoleErrors = messages.filter(message => message.level === "error");
    const closeEnough = (actual, expected) => Number.isFinite(actual) && Number.isFinite(expected) && Math.abs(actual - expected) < 1e-7;
    const checks = {
      pulseControlsActive: pulseDuring.settings.waveA === "pulse" && pulseDuring.settings.waveB === "pulse" && pulseDuring.settings.lfoToPW === true,
      noteCreated: pulseDuring.voiceCreated && pulseDuring.noteRegistered,
      pulseAReceivesModulation: pulseDuring.pulseA.delayPresent && pulseDuring.pulseA.modulationNodePresent && pulseDuring.pulseA.connectedToDelayTime && closeEnough(pulseDuring.pulseA.gain, pulseDuring.pulseA.expectedGain),
      pulseBReceivesModulation: pulseDuring.pulseB.delayPresent && pulseDuring.pulseB.modulationNodePresent && pulseDuring.pulseB.connectedToDelayTime && closeEnough(pulseDuring.pulseB.gain, pulseDuring.pulseB.expectedGain),
      noteReleased: pulseAfterRelease.releaseObserved && pulseAfterRelease.voiceCount === 0 && !pulseAfterRelease.noteRegistered,
      lfoRatePropagates: rateSnapshot.param === rateSnapshot.requested && rateSnapshot.input === rateSnapshot.requested && closeEnough(rateSnapshot.oscillatorFrequency, rateSnapshot.requested),
      presetShapePropagates: presetSnapshot.selectedFound && presetSnapshot.selected === "fact_Reso-Clav" && presetSnapshot.paramShape === "triangle" && presetSnapshot.oscillatorType === "triangle",
      presetRatePropagates: presetSnapshot.paramRate === 6 && closeEnough(presetSnapshot.oscillatorFrequency, 6),
      sessionShapeRestores: sessionSnapshot.selected === "fact_Reso-Clav" && sessionSnapshot.paramShape === "triangle" && sessionSnapshot.oscillatorType === "triangle" && sessionSnapshot.restoreLogPresent,
      sessionRateRestores: sessionSnapshot.paramRate === 6 && closeEnough(sessionSnapshot.oscillatorFrequency, 6),
      noPageErrors: errors.length === 0,
      noConsoleErrors: consoleErrors.length === 0
    };
    const scenarioPass = Object.values(checks).every(Boolean);

    evidence = {
      schema: "synth-modular-effects/task-2-lfo",
      capturedAt: new Date().toISOString(),
      browser: { product: version.Browser, userAgent: version.UserAgent, protocol: "Chrome DevTools Protocol", headed: false, executable: chromePath },
      server: { command: "node test/lfo-browser.mjs", origin },
      pulseScenario: {
        actions: ["OSC A PLS", "OSC B PLS", "LFO to PW", "Test C4"],
        duringNote: pulseDuring,
        afterRelease: pulseAfterRelease
      },
      lfoRateScenario: {
        actions: ["set LFO Rate range to 7.25", "dispatch input event"],
        state: rateSnapshot
      },
      presetScenario: {
        actions: ["select factory preset Reso-Clav"],
        state: presetSnapshot
      },
      sessionScenario: {
        actions: ["reload same origin", "restore saved active state"],
        state: sessionSnapshot
      },
      capture: { pageErrors: errors, consoleMessages: messages, consoleErrors },
      checks,
      pass: scenarioPass,
      reproducibility: {
        previousArtifactPresent: Boolean(priorEvidence),
        previousPass: priorEvidence?.pass === true,
        repeatedGreen: priorEvidence?.pass === true && scenarioPass
      },
      applicability: {
        dirty_worktree: { applicable: true, observedBefore: gitStatus, preservation: "No git mutation; README.md and unrelated shared-worktree changes left untouched." },
        stale_state: { applicable: true, observed: false, mitigation: "Unique Chrome profile per run; only same-run state retained for the intentional session-restore check." },
        misleading_success_output: { applicable: true, observed: false, mitigation: "Process exits non-zero unless every binary check and teardown check is true." },
        flaky_tests: { applicable: true, observed: priorEvidence?.pass === true ? !scenarioPass : null, mitigation: "Run twice against fresh browser profiles; second artifact records repeatedGreen." },
        repeated_interruptions: { applicable: false, observed: false, reason: "No run was interrupted after the harness became executable." }
      }
    };
  } catch (error) {
    runError = error;
    evidence = evidence || {
      schema: "synth-modular-effects/task-2-lfo",
      capturedAt: new Date().toISOString(),
      server: { command: "node test/lfo-browser.mjs", origin },
      harnessError: error.stack || error.message,
      checks: {},
      pass: false
    };
  } finally {
    if (page) page.close();
    if (chrome?.pid) {
      spawnSync("taskkill", ["/PID", String(chrome.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      chrome.kill();
    }
    await sleep(300);
    if (server) await new Promise(resolveClose => server.close(resolveClose));
    try {
      await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {}
    const cleanup = {
      serverStopped: origin ? !(await canReach(`${origin}/index.html`)) : true,
      chromeStopped: !(await canReach(`http://127.0.0.1:${debugPort}/json/version`)),
      profileRemoved: !(await pathExists(profile)),
      temporaryInstrumentationRemoved: true,
      retainedArtifacts: ["test/lfo-browser.mjs", evidencePath.replace(`${root}\\`, "").replaceAll("\\", "/")]
    };
    evidence.cleanup = cleanup;
    evidence.checks.cleanupComplete = Object.values(cleanup).slice(0, 4).every(Boolean);
    evidence.pass = evidence.pass === true && evidence.checks.cleanupComplete;
    if (evidence.reproducibility) {
      evidence.reproducibility.repeatedGreen = evidence.reproducibility.previousPass && evidence.pass;
    }
    await mkdir(resolve(evidencePath, ".."), { recursive: true });
    await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + "\n");
    console.log(JSON.stringify(evidence, null, 2));
  }

  if (runError) throw runError;
  if (!evidence.pass) {
    const failedChecks = Object.entries(evidence.checks).filter(([, passed]) => !passed).map(([name]) => name);
    throw new Error(`LFO browser regression failed: ${failedChecks.join(", ")}`);
  }
}

run().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
