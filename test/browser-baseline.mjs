#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { pageErrors, sleep, withBrowserHarness } from "./cdp-harness.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const evidencePath = resolve(process.env.SYNTH_EVIDENCE || ".omo/evidence/synth-modular-effects/task-1-browser-baseline.json");
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
  const result = await withBrowserHarness({ root, html: served.source }, async harness => {
    const { page } = harness;
    await page.command("Page.navigate", { url: `${harness.origin}/index.html?run=baseline` });
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

    await page.command("Storage.clearDataForOrigin", { origin: harness.origin, storageTypes: "all" });
    await page.command("Page.navigate", { url: `${harness.origin}/index.html?run=nonpulse` });
    await sleep(700);
    const baselineBeforeEvents = page.drainEvents();
    const baselineState = await state(page, [["waveA", ".waveform-selector[data-group=waveA] button[data-val=sawtooth]"], ["waveB", ".waveform-selector[data-group=waveB] button[data-val=sawtooth]"], ["lfoToPW", "#lfoToPW"]]);
    await click(page, "#testBtn");
    await sleep(900);
    const baselineEvents = page.drainEvents();
    const pulsePageErrors = pageErrors(pulseEvents);
    const observedPulseError = pulsePageErrors.find(error => error.text?.split(/\r?\n/, 1)[0] === requiredPulseError);
    const pulseControlsActive = pulseParams.waveA === "pulse" && pulseParams.waveB === "pulse" && pulseParams.lfoToPW === true;
    const pulseRedPass = pulseControlsActive && Boolean(observedPulseError);
    const nonPulsePass = pageErrors(baselineBeforeEvents).length === 0 && pageErrors(baselineEvents).length === 0;
    return {
      schema: "synth-modular-effects/task-1-browser-baseline",
      capturedAt: new Date().toISOString(),
      browser: { product: harness.version.Browser, userAgent: harness.version.UserAgent, protocol: "Chrome DevTools Protocol", headed: false, executable: harness.executable },
      server: { command: "node test/browser-baseline.mjs", origin: harness.origin },
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
      applicability: { dirty_worktree: true, stale_state: false, misleading_success_output: false, flaky_tests: false, repeated_interruptions: false }
    };
  });
  const evidence = result.value;
  evidence.cleanup = {
    serverStopped: result.cleanup.completed.server === true,
    chromeStopped: result.cleanup.completed.browser === true && result.cleanup.completed.page === true,
    profileRemoved: result.cleanup.completed.profile === true,
    productionFilesModified: [],
    artifactsRetained: ["test/browser-baseline.mjs", ".omo/evidence/synth-modular-effects/task-1-browser-baseline.json"]
  };
  await mkdir(resolve(evidencePath, ".."), { recursive: true });
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify(evidence, null, 2));
  if (!evidence.pass) {
    throw new Error(`Required browser baseline was not observed: controlsActive=${evidence.pulseScenario.params.waveA === "pulse" && evidence.pulseScenario.params.waveB === "pulse" && evidence.pulseScenario.params.lfoToPW === true}, capturedErrors=${JSON.stringify(evidence.pulseScenario.pageErrors.map(error => error.text?.split(/\r?\n/, 1)[0]))}, nonPulsePass=${evidence.nonPulseScenario.pass}`);
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
