import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import assert from "node:assert/strict";

const root = resolve(import.meta.dirname, "..");
const evidenceDir = resolve(root, ".omo/evidence/synth-modular-effects");
const profile = resolve(root, `.omo/effects-browser-profile-${process.pid}`);
const port = 19468;
const sleep = ms => new Promise(done => setTimeout(done, ms));
const evidence = { capturedAt: new Date().toISOString(), checks: {}, signal: {}, errors: [] };
let server, chrome, ws;
const pending = new Map();
let nextId = 0;
function command(method, params = {}) {
  return new Promise((resolveCommand, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve: resolveCommand, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
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
  await sleep(500);
  for (let i = 0; i < 100; i++) {
    try { if (await evaluate("document.readyState === 'complete' && typeof effectRack !== 'undefined' && !!document.getElementById('addEffect')")) { await evaluate('hardSyncEngine.readyPromise'); return; } } catch {}
    await sleep(100);
  }
  throw new Error("Application failed to load");
}
async function run() {
  await mkdir(evidenceDir, { recursive: true });
  server = createServer(async (req, res) => {
    if (req.url === "/favicon.ico") { res.writeHead(204); res.end(); return; }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(await readFile(resolve(root, "index.html")));
  });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${server.address().port}/index.html`;
  chrome = spawn(process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank"], { windowsHide: true, stdio: "ignore" });
  let target;
  for (let i = 0; i < 100; i++) {
    try { target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json(); break; } catch { await sleep(100); }
  }
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(done => ws.addEventListener("open", done, { once: true }));
  ws.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const handler = pending.get(message.id); pending.delete(message.id);
      if (message.error) handler.reject(new Error(message.error.message)); else handler.resolve(message.result);
    } else if (message.method === "Runtime.exceptionThrown") evidence.errors.push(message.params.exceptionDetails);
    else if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") evidence.errors.push(message.params);
  });
  await command("Runtime.enable"); await command("Page.enable");
  await load(url);
  await check("initiallyDry", "effectRack.serialize().modules.length === 0");
  await check("midiModulesSeparated", "!!document.getElementById('mod-midi') && !!document.getElementById('mod-midi-bindings') && !!document.getElementById('mod-midi-monitor') && !document.querySelector('#mod-midi #ccList') && !document.querySelector('#mod-midi #log')");
  await evaluate(`document.querySelector('#row-resonance .learn-btn').click(); onMIDIMessage({data:new Uint8Array([0xB0,1,99])});`);
  await check("learnUpdatesBindings", "ccMaps[activeBank][1] === 'resonance' && document.querySelector('#ccList [data-cc=\"1\"]')?.textContent.includes('Reson.') && document.getElementById('log').textContent.includes('Mapped CC 1 to resonance')");
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
  await check("adaptiveModules", "!isModuleActive('mod-oscB') && !document.getElementById('mod-oscB') && getComputedStyle(document.getElementById('lfoToOscB')).display === 'none' && !document.getElementById('row-mixB') && window.dialInstances.find(d=>d.canvasId==='canvas-mixer').paramIds.join(',') === 'mixA,mixNoise' && window.dialInstances.find(d=>d.canvasId==='canvas-polymod').paramIds.join(',') === 'polyFilterEnvAmt' && getComputedStyle(document.querySelector('#mod-polymod tr[data-source=\"osc-b\"]')).display === 'none'");
  await evaluate(`document.querySelector('#mod-lfo .module-remove').click();`);
  await check("wheelAdaptsToLfo", "!isModuleActive('mod-lfo') && synthModuleCards.get('mod-wheelmod').classList.contains('module-unavailable')");
  await evaluate(`for (const id of ['mod-oscB','mod-lfo']) { const add=document.getElementById('addEffect'); add.value=id; add.dispatchEvent(new Event('change')); }`);
  await check("modulesReadded", "isModuleActive('mod-oscB') && isModuleActive('mod-lfo') && !!document.getElementById('mod-oscB') && !document.getElementById('row-mixB').hidden");
  await evaluate(`localStorage.setItem('prophet_concentric_layout_order', JSON.stringify([...document.querySelectorAll('#mainGrid > .module-card')].map(card => card.id).filter(id => !['mod-midi-bindings','mod-midi-monitor'].includes(id))))`);
  await load(url + "?legacy-layout=1");
  await check("legacyMidiLayoutMigrated", "(() => { const ids=[...document.querySelectorAll('#mainGrid > .module-card')].map(card=>card.id), midi=ids.indexOf('mod-midi'); return ids[midi+1] === 'mod-midi-bindings' && ids[midi+2] === 'mod-midi-monitor'; })()");
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
    await evaluate("document.getElementById('mod-fx-delay').scrollIntoView({block:'start'})");
    await sleep(100);
    evidence[`layout${width}`] = await evaluate(`({viewport:innerWidth,client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth, offenders:[...document.querySelectorAll('body *')].map(el=>{const r=el.getBoundingClientRect();return {tag:el.tagName,id:el.id,cls:el.className,left:r.left,right:r.right,width:r.width}}).filter(x=>x.right>innerWidth+0.5||x.left<-.5).slice(0,12)})`);
    await check(`rackFits${width}`, "document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('.module-card button, .module-card canvas')].every(el => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; })");
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
  assert.equal(evidence.errors.length, 0); evidence.checks.noBrowserErrors = true;
}
try { await run(); evidence.pass = true; }
catch (error) { evidence.pass = false; evidence.failure = error.stack; process.exitCode = 1; }
finally {
  if (ws) { await command("Browser.close").catch(() => {}); ws.close(); }
  if (chrome?.pid) { spawnSync("taskkill", ["/PID", String(chrome.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); chrome.kill(); }
  if (server) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
  await sleep(300);
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  evidence.cleanup = { serverClosed: true, chromeClosed: true, profileRemoved: true };
  await writeFile(resolve(evidenceDir, "task-4-rack-dsp.json"), JSON.stringify(evidence, null, 2));
  await writeFile(resolve(evidenceDir, "task-5-rack-ui.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
}
