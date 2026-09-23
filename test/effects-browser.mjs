import { writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";

import { sleep, waitForCondition, withBrowserHarness } from "./cdp-harness.mjs";

const root = resolve(import.meta.dirname, "..");
const evidenceDir = resolve(root, ".omo/evidence/synth-modular-effects");
const evidence = { capturedAt: new Date().toISOString(), checks: {}, signal: {}, errors: [] };
let page;
const command = (method, params = {}) => page.command(method, params);
async function evaluate(expression) {
  return page.evaluate(expression);
}
const click = id => evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
const snapshot = () => evaluate("effectRack.serialize()");
async function check(name, expression) {
  const value = await evaluate(expression);
  evidence.checks[name] = value;
  assert.equal(value, true, name);
}
async function load(url) {
  await command("Page.navigate", { url });
  const loaded = await waitForCondition(page, "document.readyState === 'complete' && typeof effectRack !== 'undefined' && !!document.getElementById('addEffect')", 10_000);
  if (!loaded) throw new Error("Application failed to load");
  await evaluate("hardSyncEngine.readyPromise");
}
async function run() {
  await mkdir(evidenceDir, { recursive: true });
  return withBrowserHarness({ root }, async harness => {
    page = harness.page;
    const url = `${harness.origin}/index.html`;
    await load(url);
  await check("initiallyDry", "effectRack.serialize().modules.length === 0");
  await check("midiModulesSeparated", "!!document.getElementById('mod-midi') && !!document.getElementById('mod-midi-bindings') && !!document.getElementById('mod-midi-monitor') && !document.querySelector('#mod-midi #ccList') && !document.querySelector('#mod-midi #log')");
  await check("moduleHeaderDesign", "!document.querySelector('.module-subtitle') && getComputedStyle(document.querySelector('.module-title')).fontSize === '13px' && getComputedStyle(document.querySelector('.module-title')).fontWeight === '700' && getComputedStyle(document.querySelector('.drag-handle')).height === '0px' && getComputedStyle(document.querySelector('.drag-handle')).marginBottom === '-12px'");
  await evaluate(`document.querySelector('#row-resonance .learn-btn').click(); onMIDIMessage({data:new Uint8Array([0xB0,1,99])});`);
  await check("learnUpdatesBindings", "ccMaps[activeBank][1] === 'resonance' && document.querySelector('#ccList [data-cc=\"1\"]')?.textContent.includes('Reson.') && document.getElementById('log').textContent.includes('Mapped CC 1 to resonance')");
  await check("performanceModulesFullWidth", "['mod-sequencer','mod-recorder'].every(id => document.getElementById(id)?.classList.contains('performance-module'))");
  await evaluate(`(() => {
    allNotesOff();
    noteOn(60, 100, "live");
    noteOn(60, 100, "sequencer");
    noteOff(60, "sequencer");
    const liveSurvived = noteToVoiceIds.get(noteVoiceKey(60, "live"))?.length === 1;
    const sequencerReleased = !noteToVoiceIds.has(noteVoiceKey(60, "sequencer"));
    noteOn(62, 100, "sequencer");
    noteOn(62, 100, "sequencer");
    noteOff(62, "sequencer");
    const repeatedPitchSurvived = noteToVoiceIds.get(noteVoiceKey(62, "sequencer"))?.length === 1;
    const pendingKey = noteVoiceKey(63, "sequencer");
    pendingNotes.set(pendingKey, [{ note: 63 }, { note: 63 }]);
    noteOff(63, "sequencer");
    const pendingPitchSurvived = pendingNotes.get(pendingKey)?.length === 1;
    pendingNotes.delete(pendingKey);
    noteOff(62, "sequencer");
    noteOff(60, "live");
    window.__voiceIsolation = { liveSurvived, sequencerReleased, repeatedPitchSurvived, pendingPitchSurvived };
  })()`);
  await check("noteInstancesStayIsolated", "__voiceIsolation.liveSurvived && __voiceIsolation.sequencerReleased && __voiceIsolation.repeatedPitchSurvived && __voiceIsolation.pendingPitchSurvived");
  await evaluate(`(() => {
    const source = { P: { ...P }, octave: 0, effects: { version: 1, modules: [] }, modules: ['mod-oscB', 'not-a-module', 'mod-oscB'], modulesVersion: 3 };
    const normalized = cloneRecorderPatch(source);
    const fallback = cloneRecorderPatch({ ...source, modules: null });
    window.__patchNormalization = { normalized: normalized.modules, fallback: fallback.modules };
  })()`);
  await check("recorderPatchModulesValidated", "__patchNormalization.normalized.join(',') === 'mod-oscB' && Array.isArray(__patchNormalization.fallback) && __patchNormalization.fallback.length === Object.keys(SYNTH_MODULES).length && __patchNormalization.fallback.every(id => Object.hasOwn(SYNTH_MODULES, id))");
  await evaluate(`new Promise(resolve => {
    const track = armedRecorderTrack();
    track.events = []; track.duration = 0;
    midiRecorderState.recording = true; midiRecorderState.startedAt = performance.now();
    renderMidiRecorder();
    const before = document.querySelector('[data-track="' + track.id + '"] .track-meta').textContent;
    for (let index = 0; index < 20; index++) captureMidiRecorderEvent(index % 2 ? 'off' : 'on', 60 + index % 4, 100, 'live');
    const during = document.querySelector('[data-track="' + track.id + '"] .track-meta').textContent;
    const scheduled = typeof recorderRenderFrame !== 'undefined' && recorderRenderFrame !== null;
    midiRecorderState.recording = false;
    requestAnimationFrame(() => {
      const after = document.querySelector('[data-track="' + track.id + '"] .track-meta').textContent;
      window.__recorderRenderCoalescing = { before, during, after, scheduled, events: track.events.length };
      resolve();
    });
  })`);
  await check("recorderRenderingCoalesced", "__recorderRenderCoalescing.scheduled && __recorderRenderCoalescing.before === __recorderRenderCoalescing.during && __recorderRenderCoalescing.after.includes('20') && __recorderRenderCoalescing.events === 20");
  await evaluate(`restoreSequencer({ bpm: 120, gate: 75, selected: 0, steps: [{ active: true, note: 0, velocity: 100 }] });`);
  await check("restoredSequencerNotesStayVisible", "sequencerState.steps[0].note === 36 && document.querySelector('#seqRoll [data-step=\"0\"][data-note=\"36\"]')?.classList.contains('active')");
  await evaluate(`restoreSequencer({ bpm: 120, gate: 75, selected: 0, steps: Array.from({ length: 16 }, (_, index) => ({ active: index % 4 === 0, note: 60, velocity: 100 })) });`);
  await evaluate(`document.querySelector('#seqRoll [data-step="0"][data-note="64"]').click(); document.getElementById('seqVelocity').value='111'; document.getElementById('seqVelocity').dispatchEvent(new Event('change')); const cutoff=document.getElementById('cutoff'); cutoff.value='4321'; cutoff.dispatchEvent(new Event('input')); startMidiRecording(); onMIDIMessage({data:new Uint8Array([0x90,64,111])}); onMIDIMessage({data:new Uint8Array([0x80,64,0])}); stopMidiRecorder(); addMidiRecorderTrack(); cutoff.value='8000'; cutoff.dispatchEvent(new Event('input')); document.querySelector('#mod-oscB .module-remove').click(); startMidiRecording(); onMIDIMessage({data:new Uint8Array([0x90,67,96])}); onMIDIMessage({data:new Uint8Array([0x80,67,0])}); stopMidiRecorder(); document.querySelector('[data-track="1"]').click();`);
  await check("sequencerAndRecorderEdit", "sequencerState.steps[0].active && sequencerState.steps[0].note === 64 && sequencerState.steps[0].velocity === 111 && document.querySelectorAll('#seqKeyboard .piano-key').length === 49 && document.querySelectorAll('#seqRoll .piano-cell').length === 784 && document.querySelector('#seqRoll [data-step=\"0\"][data-note=\"64\"]')?.classList.contains('active') && getComputedStyle(document.querySelector('#seqKeyboard .piano-key')).backgroundImage.includes('gradient') && document.querySelector('#seqKeyboard .piano-key.black').getBoundingClientRect().width < document.querySelector('#seqKeyboard .piano-key:not(.black)').getBoundingClientRect().width && midiRecorderState.tracks.length === 2 && midiRecorderState.tracks.every(track => track.events.length === 2) && midiRecorderState.activeTrackId === 1 && document.querySelector('[data-track=\"1\"] .track-preview rect') && P.cutoff === 4321 && isModuleActive('mod-oscB')");
  await evaluate(`document.getElementById('seqLength').value='24'; document.getElementById('seqLength').dispatchEvent(new Event('change'));`);
  await check("sequencerRollLengthEditable", "sequencerState.steps.length === 24 && document.querySelectorAll('#seqRoll .piano-cell').length === 1176 && document.getElementById('seqLength').value === '24' && sequencerState.steps[0].note === 64");
  await evaluate(`document.getElementById('cutoff').value='5555'; document.getElementById('cutoff').dispatchEvent(new Event('input'));`);
  await check("armedTrackFollowsSynthEdits", "P.cutoff === 5555 && midiRecorderState.tracks.find(track => track.id === 1)?.patch?.P?.cutoff === 5555");
  await evaluate(`(() => {
    const first = midiRecorderState.tracks[0], second = midiRecorderState.tracks[1];
    window.__savedDenseEvents = first.events; window.__savedDenseDuration = first.duration; window.__savedDenseMute = second.mute;
    first.events = Array.from({ length: 200 }, (_, index) => ({ time: index * 10, type: index % 2 ? 'off' : 'on', note: 60 + index % 4, velocity: index % 2 ? 0 : 100 }));
    first.duration = 2000; second.mute = true;
    playMidiRecording();
    window.__recorderScheduler = { timerCount: recorderTimers.length, playing: midiRecorderState.playing };
    stopMidiRecorder(false);
    first.events = window.__savedDenseEvents; first.duration = window.__savedDenseDuration; second.mute = window.__savedDenseMute;
  })()`);
  await check("recorderPlaybackUsesBoundedScheduler", "__recorderScheduler.playing && __recorderScheduler.timerCount === 1");
  await evaluate(`new Promise(resolve => { playMidiRecording(); setTimeout(() => { window.__recorderPlaybackProof = { voices: [...voices.values()].filter(voice => voice.playback).map(voice => ({ trackId: voice.playback.trackId, cutoff: voice.params.cutoff, oscB: voice.playback.patch.modules.includes('mod-oscB') })), contexts: recorderPlaybackContexts.length, isolatedInputs: new Set(recorderPlaybackContexts.map(context => context.input)).size, selectedCutoff: P.cutoff }; stopMidiRecorder(); resolve(); }, 100); })`);
  await check("recorderTracksKeepOwnPatches", "__recorderPlaybackProof.contexts === 2 && __recorderPlaybackProof.isolatedInputs === 2 && __recorderPlaybackProof.selectedCutoff === 5555 && __recorderPlaybackProof.voices.some(voice => voice.trackId === 1 && voice.cutoff === 5555 && voice.oscB) && __recorderPlaybackProof.voices.some(voice => voice.trackId === 2 && voice.cutoff === 8000 && !voice.oscB)");
  evidence.signal = await evaluate(`(async () => {
    const result = {};
    for (const type of Object.keys(EFFECT_DEFINITIONS)) {
      const captures = [];
      for (const enabled of [false, true]) {
        const ctx = new OfflineAudioContext(2, 48000, 48000);
        const params = Object.fromEntries(Object.entries(EFFECT_DEFINITIONS[type].params).map(([key, spec]) => [key, spec[4]]));
        const effect = createEffect(ctx, { type, enabled, params });
        const buffer = ctx.createBuffer(1, 48000, 48000), input = buffer.getChannelData(0);
        for (let i = 0; i < 6000; i++) input[i] = .2 * Math.sin(i * 2 * Math.PI * 330 / 48000);
        const source = ctx.createBufferSource(); source.buffer = buffer;
        source.connect(effect.input); effect.output.connect(ctx.destination); source.start();
        const output = (await ctx.startRendering()).getChannelData(0);
        let error = 0, tail = 0, peak = 0;
        for (let i = 0; i < output.length; i++) { error += (output[i] - input[i]) ** 2; if (i > 6000) tail += output[i] ** 2; peak = Math.max(peak, Math.abs(output[i])); }
        captures.push({ error: error / output.length, tail, peak, finite: output.every(Number.isFinite) });
        effect.dispose();
      }
      result[type] = { bypass: captures[0], active: captures[1] };
    }
    return result;
  })()`);
  for (const [type, values] of Object.entries(evidence.signal)) {
    assert.ok(values.bypass.error < 1e-12, `${type} bypass dry equivalence`);
    assert.ok(values.active.error > 1e-6 && values.active.finite && values.active.peak < 1, `${type} audible bounded output`);
  }
  evidence.checks.actualEffectSignal = true;
  await evaluate(`window.__fxStops = 0; window.__fxOriginalStop = OscillatorNode.prototype.stop; OscillatorNode.prototype.stop = function(...args) { window.__fxStops++; return window.__fxOriginalStop.apply(this, args); };`);
  await click("testBtn");
  for (const type of ["delay", "reverb", "drive", "chorus"]) await evaluate(`document.getElementById('addEffect').value = '${type}'; document.getElementById('addEffect').dispatchEvent(new Event('change'))`);
  await sleep(150);
  await check("uniqueEffects", "effectRack.serialize().modules.length === 4 && [...document.querySelectorAll('#addEffect optgroup[label=\"Effects\"] option')].every(b => b.disabled) && document.querySelectorAll('#mainGrid > .effect-module canvas').length === 4");
  await evaluate(`const range = document.getElementById('fx-delay-feedback'); range.value = .65; range.dispatchEvent(new Event('input', {bubbles:true}));`);
  await click("fx-drive-enabled");
  await evaluate(`const dragged = document.getElementById('mod-fx-chorus'), handle = dragged.querySelector('.drag-handle'), target = document.getElementById('mod-fx-drive'); handle.dispatchEvent(new PointerEvent('pointerdown', {bubbles:true, pointerType:'mouse'})); dragged.dispatchEvent(new DragEvent('dragstart', {bubbles:true, cancelable:true})); target.dispatchEvent(new DragEvent('drop', {bubbles:true, cancelable:true})); dragged.dispatchEvent(new DragEvent('dragend', {bubbles:true}));`);
  await sleep(100);
  await check("orderAndParameters", "effectRack.serialize().modules.map(m=>m.type).join(',') === 'delay,reverb,chorus,drive' && effectRack.serialize().modules[0].params.feedback === .65 && !effectRack.serialize().modules[3].enabled");
  await evaluate(`document.querySelector('#mod-oscB .module-remove').click();`);
  await check("adaptiveModules", "!isModuleActive('mod-oscB') && !document.getElementById('mod-oscB') && getComputedStyle(document.getElementById('lfoToOscB')).display === 'none' && !document.getElementById('row-mixB') && window.dialInstances.find(d=>d.canvasId==='canvas-mixer').paramIds.join(',') === 'mixA,mixNoise' && window.dialInstances.find(d=>d.canvasId==='canvas-polymod').paramIds.join(',') === 'polyFilterEnvAmt' && getComputedStyle(document.querySelector('#mod-polymod tr[data-source=\"osc-b\"]')).display === 'none' && getComputedStyle(document.querySelector('#mod-polymod tr[data-source=\"filter-envelope\"]')).display === 'table-row'");
  await evaluate(`document.querySelector('#mod-lfo .module-remove').click();`);
  await check("wheelAdaptsToLfo", "!isModuleActive('mod-lfo') && synthModuleCards.get('mod-wheelmod').classList.contains('module-unavailable')");
  await evaluate(`for (const id of ['mod-oscB','mod-lfo']) { const add=document.getElementById('addEffect'); add.value=id; add.dispatchEvent(new Event('change')); }`);
  await check("modulesReadded", "isModuleActive('mod-oscB') && isModuleActive('mod-lfo') && !!document.getElementById('mod-oscB') && !document.getElementById('row-mixB').hidden");
  await evaluate(`document.querySelector('#mod-filterEnv .module-remove').click();`);
  await check("filterEnvelopeDependenciesAdapt", "!isModuleActive('mod-filterEnv') && getComputedStyle(document.querySelector('#mod-polymod tr[data-source=\"filter-envelope\"]')).display === 'none' && getComputedStyle(document.querySelector('#mod-polymod tr[data-source=\"osc-b\"]')).display === 'table-row'");
  await evaluate(`const add=document.getElementById('addEffect'); add.value='mod-filterEnv'; add.dispatchEvent(new Event('change'));`);
  await evaluate(`localStorage.setItem('prophet_concentric_layout_order', JSON.stringify([...document.querySelectorAll('#mainGrid > .module-card')].map(card => card.id).filter(id => !['mod-midi-bindings','mod-midi-monitor'].includes(id))))`);
  await load(url + "?legacy-layout=1");
  await check("legacyMidiLayoutMigrated", "(() => { const ids=[...document.querySelectorAll('#mainGrid > .module-card')].map(card=>card.id), midi=ids.indexOf('mod-midi'); return ids[midi+1] === 'mod-midi-bindings' && ids[midi+2] === 'mod-midi-monitor'; })()");
  await check("performanceSessionRestored", "sequencerState.steps.length === 24 && sequencerState.steps[0].note === 64 && sequencerState.steps[0].velocity === 111 && midiRecorderState.tracks.length === 2 && midiRecorderState.tracks[0].events.length === 2 && midiRecorderState.tracks[0].patch?.P?.cutoff === 5555 && !!document.querySelector('[data-track=\"1\"] .track-preview rect')");
  await evaluate(`window.prompt=()=>'<Lead & Bass>'; window.confirm=()=>true; document.querySelector('[data-track="1"] [data-action="rename"]').click(); document.querySelector('[data-track="2"] [data-action="clear"]').click(); document.getElementById('seqClear').click();`);
  await check("performanceContentCanBeReset", "midiRecorderState.tracks[0].name === '<Lead & Bass>' && document.querySelector('[data-track=\"1\"] .track-name').textContent === '<Lead & Bass>' && !document.querySelector('[data-track=\"1\"] .track-name img') && midiRecorderState.tracks[1].events.length === 0 && midiRecorderState.tracks[1].duration === 0 && midiRecorderState.tracks[1].patch?.P?.cutoff === 8000 && sequencerState.steps.length === 24 && sequencerState.steps.every(step => !step.active && step.note === 60 && step.velocity === 100)");
  const expected = await snapshot();
  await evaluate("window.prompt = () => 'Rack QA'; document.getElementById('savePresetBtn').click()");
  await load(url + "?restore=1");
  assert.deepEqual(await snapshot(), expected); evidence.checks.sessionRestored = true;
  await click("fx-delay-remove"); await sleep(80);
  await evaluate(`const select = document.getElementById('presetSelect'); select.value = 'user_Rack QA'; select.dispatchEvent(new Event('change', {bubbles:true}));`);
  assert.deepEqual(await snapshot(), expected); evidence.checks.userPresetRestored = true;
  await evaluate(`document.getElementById('presetSelect').value = 'fact_Reso-Clav'; document.getElementById('presetSelect').dispatchEvent(new Event('change', {bubbles:true}));`);
  assert.deepEqual(await snapshot(), expected); evidence.checks.factoryPreservesRack = true;
  for (const width of [375, 768, 1280]) {
    await command("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: false });
    await evaluate("document.getElementById('mod-sequencer').scrollIntoView({block:'start'})");
    await sleep(100);
    const performanceCapture = await command("Page.captureScreenshot", { format: "png" });
    await writeFile(resolve(evidenceDir, `task-5-performance-${width}.png`), Buffer.from(performanceCapture.data, "base64"));
    await evaluate("document.getElementById('mod-recorder').scrollIntoView({block:'start'})");
    await sleep(100);
    const recorderCapture = await command("Page.captureScreenshot", { format: "png" });
    await writeFile(resolve(evidenceDir, `task-5-recorder-${width}.png`), Buffer.from(recorderCapture.data, "base64"));
    await evaluate("document.getElementById('mod-fx-delay').scrollIntoView({block:'start'})");
    await sleep(100);
    evidence[`layout${width}`] = await evaluate(`({viewport:innerWidth,client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth, offenders:[...document.querySelectorAll('body *')].filter(el=>!el.closest('.piano-roll-shell')).map(el=>{const r=el.getBoundingClientRect();return {tag:el.tagName,id:el.id,cls:el.className,left:r.left,right:r.right,width:r.width}}).filter(x=>x.right>document.documentElement.clientWidth+0.5||x.left<-.5).slice(0,12)})`);
    await check(`rackFits${width}`, `document.documentElement.scrollWidth <= document.documentElement.clientWidth && [...document.querySelectorAll('.module-card button, .module-card canvas')].filter(el => !el.closest('.piano-roll-shell')).every(el => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= document.documentElement.clientWidth; }) && (${width} >= 1000 || document.querySelector('.piano-roll-shell').scrollWidth > document.querySelector('.piano-roll-shell').clientWidth)`);
    const capture = await command("Page.captureScreenshot", { format: "png" });
    await writeFile(resolve(evidenceDir, `task-5-rack-${width}.png`), Buffer.from(capture.data, "base64"));
  }
  await evaluate(`window.__fxStops = 0; window.__fxOriginalStop = OscillatorNode.prototype.stop; OscillatorNode.prototype.stop = function(...args) { window.__fxStops++; return window.__fxOriginalStop.apply(this, args); };`);
  for (const type of ["delay", "reverb", "chorus", "drive"]) await click(`fx-${type}-remove`);
  await sleep(150);
  await check("removedAll", "effectRack.serialize().modules.length === 0 && document.querySelectorAll('.effect-module').length === 0 && !window.dialInstances.some(d=>d.canvasId.startsWith('canvas-fx-')) && window.__fxStops === 1");
  const empty = await command("Page.captureScreenshot", { format: "png" });
  await writeFile(resolve(evidenceDir, "task-5-rack-empty.png"), Buffer.from(empty.data, "base64"));
  await evaluate(`const saved = JSON.parse(localStorage.getItem('prophet_concentric_active_state')); saved.effects = {version:1,modules:[{type:'not-an-effect',enabled:true,params:{}}]}; localStorage.setItem('prophet_concentric_active_state', JSON.stringify(saved));`);
  await load(url + "?malformed=1");
  await check("malformedSafe", "effectRack.serialize().modules.length === 0 && validateEffectsState({version:1,modules:[{type:'delay',enabled:true,params:{time:null,feedback:.5,mix:.5}}]}).modules.length === 0");
    const browserEvents = page.drainEvents();
    evidence.errors.push(...browserEvents.filter(event => event.type === "pageerror").map(event => event.value));
    evidence.errors.push(...browserEvents.filter(event => event.type === "console" && event.value.level === "error").map(event => event.raw));
    assert.equal(evidence.errors.length, 0); evidence.checks.noBrowserErrors = true;
  });
}
let cleanup;
try { const result = await run(); cleanup = result.cleanup; evidence.pass = true; }
catch (error) { cleanup = error.harnessCleanup; evidence.pass = false; evidence.failure = error.stack; process.exitCode = 1; }
finally {
  evidence.cleanup = {
    serverClosed: cleanup?.completed.server === true,
    chromeClosed: cleanup?.completed.browser === true && cleanup?.completed.page === true,
    profileRemoved: cleanup?.completed.profile === true
  };
  await writeFile(resolve(evidenceDir, "task-4-rack-dsp.json"), JSON.stringify(evidence, null, 2));
  await writeFile(resolve(evidenceDir, "task-5-rack-ui.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
}
