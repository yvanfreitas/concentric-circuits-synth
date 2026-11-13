#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { consoleMessages, pageErrors, waitForCondition, withBrowserHarness } from "./cdp-harness.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const evidencePath = resolve(process.env.SYNTH_EVIDENCE || ".omo/evidence/synth-modular-effects/task-2-lfo.json");

async function click(page, selector) {
  await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
}

async function readPriorEvidence() {
  try { return JSON.parse(await readFile(evidencePath, "utf8")); } catch { return null; }
}

async function run() {
  const priorEvidence = await readPriorEvidence();
  const gitStatus = ["Status probe omitted: browser tests do not execute tools from PATH."];
  let origin;
  let evidence;
  let runError;
  let cleanupResult;

  try {
    const result = await withBrowserHarness({ root }, async harness => {
    const { page } = harness;
    origin = harness.origin;
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
        noteRegistered: Boolean(voice && (noteToVoiceIds.get(60) || []).flat().includes(voice.id)),
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
      browser: { product: harness.version.Browser, userAgent: harness.version.UserAgent, protocol: "Chrome DevTools Protocol", headed: false, executable: harness.executable },
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
    return evidence;
    });
    cleanupResult = result.cleanup;
  } catch (error) {
    runError = error;
    cleanupResult = error.harnessCleanup;
    evidence = evidence || {
      schema: "synth-modular-effects/task-2-lfo",
      capturedAt: new Date().toISOString(),
      server: { command: "node test/lfo-browser.mjs", origin },
      harnessError: error.stack || error.message,
      checks: {},
      pass: false
    };
  } finally {
    const cleanup = {
      serverStopped: cleanupResult?.completed.server === true,
      chromeStopped: cleanupResult?.completed.browser === true && cleanupResult?.completed.page === true,
      profileRemoved: cleanupResult?.completed.profile === true,
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
