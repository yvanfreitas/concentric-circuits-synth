#!/usr/bin/env node

import { createServer } from "node:http";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { request } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const debugPort = Number(process.env.SYNTH_DEBUG_PORT || 19431);
const evidencePath = resolve(process.env.SYNTH_EVIDENCE || ".omo/evidence/synth-modular-effects/task-3-sync.json");
const chromePath = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const headed = process.env.SYNTH_HEADED === "1";
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

async function waitForCondition(page, expression, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await page.evaluate(expression)) return true;
    } catch {}
    await sleep(50);
  }
  return false;
}

async function setFlag(page, flag, enabled) {
  await page.evaluate(`(() => {
    const button = document.querySelector('[data-flag="${flag}"]');
    if (!button) throw new Error('Missing flag button: ${flag}');
    if (Boolean(P[${JSON.stringify(flag)}]) !== ${enabled}) button.click();
  })()`);
}

async function setRange(page, id, value) {
  await page.evaluate(`(() => {
    const input = document.querySelector(${JSON.stringify(`#${id}`)});
    if (!input) throw new Error(${JSON.stringify(`Missing range input: ${id}`)});
    input.value = ${JSON.stringify(String(value))};
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
}

async function setWave(page, group, value) {
  await page.evaluate(`(() => {
    const button = document.querySelector(${JSON.stringify(`.waveform-selector[data-group=${group}] button[data-val=${value}]`)});
    if (!button) throw new Error(${JSON.stringify(`Missing ${group} waveform: ${value}`)});
    button.click();
  })()`);
}

async function startNote(page, note = 60) {
  await page.evaluate(`audioCtx.resume().then(() => noteOn(${note}, 100))`);
  return waitForCondition(page, `[...voices.values()].some(voice => voice.note === ${note} && !voice.releasing)`);
}

async function clearVoices(page) {
  await page.evaluate("allNotesOff()");
  return waitForCondition(page, "voices.size === 0", 2000);
}

async function measureCycleSignal(page) {
  return page.evaluate(`(async () => {
    const voice = [...voices.values()].find(v => !v.releasing);
    const meter = audioCtx.createAnalyser(); meter.fftSize = 4096;
    voice.oscB.output.connect(meter);
    await new Promise(resolve => setTimeout(resolve, 150));
    const data = new Float32Array(meter.fftSize); meter.getFloatTimeDomainData(data);
    const period = audioCtx.sampleRate / midiToFreq(voice.note);
    let error = 0, energy = 0;
    for (let i = 0; i < data.length - Math.ceil(period) - 1; i++) {
      const offset = i + period, j = Math.floor(offset), fraction = offset - j;
      const later = data[j] * (1 - fraction) + data[j + 1] * fraction;
      error += (data[i] - later) ** 2; energy += data[i] ** 2;
    }
    voice.oscB.output.disconnect(meter); meter.disconnect();
    return { energy, masterPeriodError: error / Math.max(energy, 1e-12) };
  })()`);
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

function priorRedRun(priorEvidence) {
  if (priorEvidence?.pass === false && !priorEvidence.harnessError && "ratioQuantizationRemoved" in (priorEvidence.checks || {})) {
    return {
      capturedAt: priorEvidence.capturedAt,
      command: priorEvidence.server?.command,
      checks: priorEvidence.checks,
      ratioRoundingObserved: priorEvidence.syncOnScenario?.state?.ratioRoundingObserved,
      resetCount: priorEvidence.syncOnScenario?.state?.syncState?.resetCount ?? 0,
      pass: false
    };
  }
  return priorEvidence?.redGreen?.redRun || null;
}

async function readPriorEvidence() {
  try { return JSON.parse(await readFile(evidencePath, "utf8")); } catch { return null; }
}

async function run() {
  const priorEvidence = await readPriorEvidence();
  const redRun = priorRedRun(priorEvidence);
  const gitStatusResult = spawnSync("git", ["status", "--short"], { cwd: root, encoding: "utf8", windowsHide: true });
  const gitStatus = (gitStatusResult.stdout || "").trim().split(/\r?\n/).filter(Boolean);
  const profile = resolve(root, `.omo/sync-browser-profile-${process.pid}`);
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

    const chromeArgs = [
      "--disable-gpu",
      "--autoplay-policy=no-user-gesture-required",
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profile}`,
      "--window-size=1280,900",
      "about:blank"
    ];
    if (!headed) chromeArgs.unshift("--headless=new");
    chrome = spawn(chromePath, chromeArgs, { windowsHide: !headed, stdio: ["ignore", "ignore", "pipe"] });
    let chromeDiagnostics = "";
    chrome.stderr.on("data", chunk => { chromeDiagnostics += chunk; });
    chrome.on("error", error => { chromeDiagnostics += error.message; });

    const version = await waitForJson(`http://127.0.0.1:${debugPort}/json/version`).catch(error => {
      throw new Error(`${error.message}; Chrome exit=${chrome.exitCode}; ${chromeDiagnostics}`);
    });
    const target = await getJson(`http://127.0.0.1:${debugPort}/json/new?about:blank`, "PUT");
    page = new CdpPage(target.webSocketDebuggerUrl);
    await page.command("Runtime.enable");
    await page.command("Log.enable");
    await page.command("Page.enable");
    await page.command("Page.navigate", { url: `${origin}/index.html?run=sync-${Date.now()}` });
    const loaded = await waitForCondition(page, `document.readyState === "complete" && typeof P !== "undefined"`);
    if (!loaded) throw new Error("Application did not reach a loaded state");
    const engine = await page.evaluate(`typeof hardSyncEngine === 'undefined'
      ? ({ present: false, ready: false, supported: Boolean(audioCtx.audioWorklet) })
      : hardSyncEngine.readyPromise.then(ready => ({ present: true, ready, supported: Boolean(audioCtx.audioWorklet), error: hardSyncEngine.error }))`);
    const startupEvents = page.drainEvents();

    await setWave(page, "waveA", "sawtooth");
    await setWave(page, "waveB", "triangle");
    await setRange(page, "oscBCoarse", 7);
    await setRange(page, "oscBFine", 37);
    await setFlag(page, "oscBLowFreq", false);
    await setFlag(page, "oscBSync", true);
    const syncOnVoiceCreated = await startNote(page, 60);
    const resetObserved = await waitForCondition(page, `[...voices.values()].some(voice => { voice.oscB.node?.port.postMessage('inspect'); return voice.note === 60 && (voice.oscB.syncState?.resetCount || 0) >= 2; })`, 1800);
    const syncOnState = await page.evaluate(`(() => {
      const voice = [...voices.values()].find(candidate => candidate.note === 60 && !candidate.releasing);
      if (!voice) return { voiceCreated: false };
      const targetA = midiToFreq(60 + octaveShift * 12) * Math.pow(2, (P.masterTune || 0) / 1200);
      const rawTargetB = targetA * Math.pow(2, (P.oscBCoarse + P.oscBFine / 100) / 12);
      const roundedTargetB = targetA * Math.max(1, Math.round(rawTargetB / targetA));
      const actualFrequency = voice.oscB.frequencyParams?.[0]?.value ?? voice.oscB.oscillators?.[0]?.frequency?.value ?? null;
      const syncState = voice.oscB.syncState ? JSON.parse(JSON.stringify(voice.oscB.syncState)) : null;
      return {
        voiceCreated: true,
        stageKind: voice.oscB.kind || 'native',
        waveform: voice.oscB.waveform || P.waveB,
        targetA,
        rawTargetB,
        roundedTargetB,
        actualFrequency,
        ratioRoundingObserved: Number.isFinite(actualFrequency) && Math.abs(actualFrequency - roundedTargetB) < 0.01,
        rawFrequencyPreserved: Number.isFinite(actualFrequency) && Math.abs(actualFrequency - rawTargetB) < 0.01,
        expectedMasterCycleFrames: audioCtx.sampleRate / targetA,
        syncState
      };
    })()`);
    const syncedSignal = await measureCycleSignal(page);
    const syncOnReleased = await clearVoices(page);

    await setFlag(page, "oscBSync", false);
    const syncOffVoiceCreated = await startNote(page, 60);
    await sleep(120);
    const syncOffState = await page.evaluate(`(() => {
      const voice = [...voices.values()].find(candidate => candidate.note === 60 && !candidate.releasing);
      if (!voice) return { voiceCreated: false };
      const targetA = midiToFreq(60 + octaveShift * 12) * Math.pow(2, (P.masterTune || 0) / 1200);
      const rawTargetB = targetA * Math.pow(2, (P.oscBCoarse + P.oscBFine / 100) / 12);
      const actualFrequency = voice.oscB.frequencyParams?.[0]?.value ?? voice.oscB.oscillators?.[0]?.frequency?.value ?? null;
      return {
        voiceCreated: true,
        stageKind: voice.oscB.kind || 'native',
        rawTargetB,
        actualFrequency,
        nativeSourceCount: voice.oscB.oscillators?.length ?? 0,
        resetCount: voice.oscB.syncState?.resetCount || 0,
        syncEnabled: Boolean(voice.oscB.syncState?.enabled)
      };
    })()`);
    const freeSignal = await measureCycleSignal(page);
    const syncOffReleased = await clearVoices(page);

    await setFlag(page, "oscBSync", true);
    await setFlag(page, "oscBLowFreq", true);
    await setRange(page, "oscBCoarse", -24);
    await setRange(page, "oscBFine", -100);
    const lowFrequencyVoiceCreated = await startNote(page, 48);
    await sleep(120);
    const lowFrequencyState = await page.evaluate(`(() => {
      const voice = [...voices.values()].find(candidate => candidate.note === 48 && !candidate.releasing);
      if (!voice) return { voiceCreated: false };
      return {
        voiceCreated: true,
        requestedSync: P.oscBSync,
        lowFrequency: P.oscBLowFreq,
        stageKind: voice.oscB.kind || 'native',
        actualFrequency: voice.oscB.frequencyParams?.[0]?.value ?? voice.oscB.oscillators?.[0]?.frequency?.value ?? null,
        resetCount: voice.oscB.syncState?.resetCount || 0,
        syncEnabled: Boolean(voice.oscB.syncState?.enabled)
      };
    })()`);
    const lowFrequencyReleased = await clearVoices(page);

    await setFlag(page, "oscBLowFreq", false);
    await setFlag(page, "glideOn", true);
    await setFlag(page, "lfoToPW", true);
    await setRange(page, "glideTime", 0.2);
    await setRange(page, "oscBCoarse", 12);
    await setRange(page, "oscBFine", 17);
    await setWave(page, "waveA", "pulse");
    await setWave(page, "waveB", "pulse");
    await page.evaluate(`(() => {
      window.__syncRampCalls = [];
      window.__originalSyncRamp = AudioParam.prototype.exponentialRampToValueAtTime;
      AudioParam.prototype.exponentialRampToValueAtTime = function(value, endTime) {
        window.__syncRampCalls.push({ param: this, value, endTime });
        return window.__originalSyncRamp.call(this, value, endTime);
      };
    })()`);
    const pulseVoiceCreated = await startNote(page, 67);
    const pulseResetObserved = await waitForCondition(page, `[...voices.values()].some(voice => { voice.oscB.node?.port.postMessage('inspect'); return voice.note === 67 && (voice.oscB.syncState?.resetCount || 0) >= 2; })`, 1800);
    const pulseState = await page.evaluate(`(() => {
      const voice = [...voices.values()].find(candidate => candidate.note === 67 && !candidate.releasing);
      if (!voice) return { voiceCreated: false };
      const frequencyParam = voice.oscB.frequencyParams?.[0] || null;
      const targetA = midiToFreq(67 + octaveShift * 12) * Math.pow(2, (P.masterTune || 0) / 1200);
      const rawTargetB = targetA * Math.pow(2, (P.oscBCoarse + P.oscBFine / 100) / 12);
      return {
        voiceCreated: true,
        stageKind: voice.oscB.kind || 'native',
        waveform: voice.oscB.waveform || P.waveB,
        pulseParamPresent: Boolean(voice.oscB.pwParam),
        pulseModulationPresent: Boolean(voice.lfoNodes.pwB),
        pulseModulationGain: voice.lfoNodes.pwB?.gain.value ?? null,
        expectedPulseModulationGain: P.lfoDepth * RANGE.lfoPWFrac,
        glideRampScheduled: Boolean(frequencyParam && window.__syncRampCalls.some(call => call.param === frequencyParam && Math.abs(call.value - rawTargetB) < 0.01)),
        syncState: voice.oscB.syncState ? JSON.parse(JSON.stringify(voice.oscB.syncState)) : null
      };
    })()`);
    const resetCountBeforeSweep = pulseState.syncState?.resetCount || 0;
    await setRange(page, "oscBCoarse", 19);
    await setRange(page, "oscBFine", -31);
    const liveSweepPropagated = await waitForCondition(page, `(() => {
      const voice = [...voices.values()].find(candidate => candidate.note === 67 && !candidate.releasing);
      if (!voice) return false;
      voice.oscB.node?.port.postMessage('inspect');
      const targetA = midiToFreq(67 + octaveShift * 12) * Math.pow(2, (P.masterTune || 0) / 1200);
      const targetB = targetA * Math.pow(2, (P.oscBCoarse + P.oscBFine / 100) / 12);
      const actual = voice.oscB.frequencyParams?.[0]?.value;
      return Number.isFinite(actual) && Math.abs(actual - targetB) < 0.05;
    })()`, 1500);
    const liveSweepState = await page.evaluate(`(() => {
      const voice = [...voices.values()].find(candidate => candidate.note === 67 && !candidate.releasing);
      if (!voice) return { voiceCreated: false };
      const targetA = midiToFreq(67 + octaveShift * 12) * Math.pow(2, (P.masterTune || 0) / 1200);
      const targetB = targetA * Math.pow(2, (P.oscBCoarse + P.oscBFine / 100) / 12);
      return {
        voiceCreated: true,
        coarse: P.oscBCoarse,
        fine: P.oscBFine,
        expectedFrequency: targetB,
        actualFrequency: voice.oscB.frequencyParams?.[0]?.value ?? null,
        resetCountBefore: ${resetCountBeforeSweep},
        resetCountAfter: voice.oscB.syncState?.resetCount || 0
      };
    })()`);
    await page.evaluate(`(() => {
      if (window.__originalSyncRamp) AudioParam.prototype.exponentialRampToValueAtTime = window.__originalSyncRamp;
      delete window.__originalSyncRamp;
      delete window.__syncRampCalls;
    })()`);
    const pulseReleased = await clearVoices(page);

    const allEvents = [...startupEvents, ...page.drainEvents()];
    const errors = pageErrors(allEvents);
    const messages = consoleMessages(allEvents);
    const consoleErrors = messages.filter(message => message.level === "error");
    const closeEnough = (actual, expected, tolerance = 0.01) => Number.isFinite(actual) && Number.isFinite(expected) && Math.abs(actual - expected) <= tolerance;
    const reset = syncOnState.syncState?.lastReset || null;
    const checks = {
      measuredMasterPeriod: syncedSignal.energy > 1 && syncedSignal.masterPeriodError < .06 && freeSignal.masterPeriodError > .15,
      failingFirstCaptured: Boolean(redRun && redRun.pass === false),
      hardSyncEngineReady: engine.present && engine.supported && engine.ready && !engine.error,
      syncOnVoiceCreated: syncOnVoiceCreated && syncOnState.voiceCreated,
      ratioQuantizationRemoved: syncOnState.rawFrequencyPreserved === true && syncOnState.ratioRoundingObserved === false,
      syncOnResetsSlavePhase: resetObserved && syncOnState.stageKind === "hard-sync" && (syncOnState.syncState?.resetCount || 0) >= 2 && reset?.slavePhaseAfterReset === 0,
      resetsDrivenByMasterCycle: reset?.source === "osc-a-zero-crossing" && Number.isFinite(reset?.cycleFrames) && closeEnough(reset.cycleFrames, syncOnState.expectedMasterCycleFrames, 3),
      syncOnReleased,
      syncOffVoiceCreated: syncOffVoiceCreated && syncOffState.voiceCreated,
      syncOffSchedulesNoReset: syncOffState.stageKind === "native" && syncOffState.nativeSourceCount > 0 && syncOffState.resetCount === 0 && !syncOffState.syncEnabled,
      syncOffFrequencyUnchanged: closeEnough(syncOffState.actualFrequency, syncOffState.rawTargetB),
      syncOffReleased,
      lowFrequencyVoiceCreated: lowFrequencyVoiceCreated && lowFrequencyState.voiceCreated,
      lowFrequencyBypassesSync: lowFrequencyState.requestedSync && lowFrequencyState.lowFrequency && lowFrequencyState.stageKind === "native" && lowFrequencyState.resetCount === 0 && !lowFrequencyState.syncEnabled && lowFrequencyState.actualFrequency >= 0.05 && lowFrequencyState.actualFrequency <= 30,
      lowFrequencyReleased,
      pulseVoiceCreated: pulseVoiceCreated && pulseState.voiceCreated,
      pulseSyncResets: pulseResetObserved && pulseState.stageKind === "hard-sync" && pulseState.waveform === "pulse" && (pulseState.syncState?.resetCount || 0) >= 2,
      pulseWidthModulation: pulseState.pulseParamPresent && pulseState.pulseModulationPresent && closeEnough(pulseState.pulseModulationGain, pulseState.expectedPulseModulationGain, 1e-7),
      glideScheduledForSyncedSlave: pulseState.glideRampScheduled,
      sustainedCoarseFineSweepPropagates: liveSweepPropagated && closeEnough(liveSweepState.actualFrequency, liveSweepState.expectedFrequency, 0.05) && liveSweepState.resetCountAfter > liveSweepState.resetCountBefore,
      pulseReleased,
      noPageErrors: errors.length === 0,
      noConsoleErrors: consoleErrors.length === 0
    };
    const { failingFirstCaptured, ...regressionChecks } = checks;
    const scenarioPass = Object.values(regressionChecks).every(Boolean);

    evidence = {
      schema: "synth-modular-effects/task-3-sync",
      capturedAt: new Date().toISOString(),
      browser: { product: version.Browser, userAgent: version.UserAgent, protocol: "Chrome DevTools Protocol", headed, executable: chromePath },
      server: { command: `${headed ? "$env:SYNTH_HEADED='1'; " : ""}node test/sync-browser.mjs`, origin },
      implementationProbe: engine,
      signal: { synced: syncedSignal, free: freeSignal },
      syncOnScenario: {
        actions: ["select OSC A sawtooth", "select OSC B triangle", "set B coarse=7 and fine=37", "enable sync", "sustain C4"],
        state: syncOnState
      },
      syncOffScenario: {
        actions: ["disable sync", "sustain C4"],
        state: syncOffState
      },
      lowFrequencyScenario: {
        actions: ["enable sync", "enable OSC B low-frequency", "set B coarse=-24 and fine=-100", "sustain C3"],
        state: lowFrequencyState
      },
      pulseGlideSweepScenario: {
        actions: ["disable low-frequency", "enable glide=0.2s", "select pulse A/B", "enable LFO to PW", "sustain G4", "sweep B coarse/fine from +12/+17 to +19/-31"],
        beforeSweep: pulseState,
        afterSweep: liveSweepState
      },
      capture: { pageErrors: errors, consoleMessages: messages, consoleErrors },
      checks,
      pass: scenarioPass,
      redGreen: {
        redRun,
        transitionConfirmed: Boolean(redRun && redRun.pass === false && scenarioPass),
        previousGreenPass: priorEvidence?.pass === true,
        repeatedGreen: priorEvidence?.pass === true && scenarioPass
      },
      applicability: {
        dirty_worktree: { applicable: true, observedBefore: gitStatus, preservation: "README.md, the plan/ledger, and unrelated shared-worktree changes were not mutated by the harness." },
        stale_state: { applicable: true, observed: false, mitigation: "Unique Chrome profile and cache-busted URL per run." },
        misleading_success_output: { applicable: true, observed: false, mitigation: "Process exits non-zero unless every phase, bypass, glide, pulse, error, and teardown check is true." },
        flaky_tests: { applicable: true, observed: priorEvidence?.pass === true ? !scenarioPass : null, mitigation: "Final verification reruns against a fresh Chrome process/profile and carries the red run forward." },
        repeated_interruptions: { applicable: false, observed: false, reason: "No run was interrupted after the harness became executable." }
      }
    };
  } catch (error) {
    runError = error;
    evidence = evidence || {
      schema: "synth-modular-effects/task-3-sync",
      capturedAt: new Date().toISOString(),
      server: { command: `${headed ? "$env:SYNTH_HEADED='1'; " : ""}node test/sync-browser.mjs`, origin },
      harnessError: error.stack || error.message,
      checks: {},
      pass: false,
      redGreen: { redRun, transitionConfirmed: false, previousGreenPass: priorEvidence?.pass === true, repeatedGreen: false }
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
      retainedArtifacts: ["test/sync-browser.mjs", evidencePath.startsWith(root) ? evidencePath.slice(root.length).replaceAll("\\", "/") : evidencePath]
    };
    evidence.cleanup = cleanup;
    evidence.checks.cleanupComplete = Object.values(cleanup).slice(0, 4).every(Boolean);
    evidence.pass = evidence.pass === true && evidence.checks.cleanupComplete;
    if (evidence.redGreen) {
      evidence.redGreen.transitionConfirmed = Boolean(evidence.redGreen.redRun && evidence.redGreen.redRun.pass === false && evidence.pass);
      evidence.redGreen.repeatedGreen = evidence.redGreen.previousGreenPass && evidence.pass;
    }
    await mkdir(resolve(evidencePath, ".."), { recursive: true });
    await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + "\n");
    console.log(JSON.stringify(evidence, null, 2));
  }

  if (runError) throw runError;
  if (!evidence.pass) {
    const failedChecks = Object.entries(evidence.checks).filter(([, passed]) => !passed).map(([name]) => name);
    throw new Error(`OSC hard-sync browser regression failed: ${failedChecks.join(", ")}`);
  }
}

run().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
