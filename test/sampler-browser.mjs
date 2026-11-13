#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const profile = resolve(root, `.omo/sampler-browser-profile-${process.pid}`);
const evidenceDir = resolve(root, ".omo/evidence/sampler");
const chromePath = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const sleep = milliseconds => new Promise(resolveSleep => setTimeout(resolveSleep, milliseconds));
let server, chrome, socket, nextId = 0;
const pending = new Map();
const pageErrors = [];

function command(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolveCommand, rejectCommand) => {
    pending.set(id, { resolveCommand, rejectCommand });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}

async function waitFor(check, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await check()) return;
    await sleep(50);
  }
  throw new Error("Timed out waiting for browser condition.");
}

function makeWaveExpression() {
  return `(() => {
    const bytes = new Uint8Array(844), view = new DataView(bytes.buffer), text = (offset, value) => [...value].forEach((char, index) => bytes[offset + index] = char.charCodeAt(0));
    text(0, "RIFF"); view.setUint32(4, 836, true); text(8, "WAVEfmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 8000, true); view.setUint32(28, 8000, true); view.setUint16(32, 1, true); view.setUint16(34, 8, true); text(36, "data"); view.setUint32(40, 800, true);
    for (let index = 44; index < bytes.length; index += 1) bytes[index] = 128 + Math.round(80 * Math.sin((index - 44) / 12));
    return new File([bytes], "example-loop.wav", { type: "audio/wav" });
  })()`;
}

function installFakeRecorderExpression() {
  return `(() => {
    const originalMediaRecorder = window.MediaRecorder, originalMediaDevices = navigator.mediaDevices, tracks = [];
    class FakeMediaRecorder extends EventTarget {
      static isTypeSupported() { return false; }
      constructor(stream) { super(); this.stream = stream; this.state = 'inactive'; this.mimeType = 'audio/webm;codecs=opus'; }
      start() { this.state = 'recording'; }
      stop() { if (this.state === 'inactive') return; this.state = 'inactive'; this.dispatchEvent(new BlobEvent('dataavailable', { data: ${makeWaveExpression()} })); this.dispatchEvent(new Event('stop')); }
    }
    window.MediaRecorder = FakeMediaRecorder;
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => tracks.push('stopped') }] }) } });
    window.__samplerTest = { originalMediaRecorder, originalMediaDevices, tracks };
  })()`;
}

async function run() {
  const evidence = { capturedAt: new Date().toISOString(), checks: {}, screenshots: [], errors: pageErrors };
  await mkdir(evidenceDir, { recursive: true });
  server = createServer(async (_request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(await readFile(resolve(root, "index.html")));
  });
  await new Promise(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const debugPort = 19511;
  chrome = spawn(chromePath, ["--headless=new", "--autoplay-policy=no-user-gesture-required", `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, "about:blank"], { windowsHide: true, stdio: "ignore" });
  try {
    let target;
    await waitFor(async () => {
      try { target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?${origin}/index.html`, { method: "PUT" })).json(); return Boolean(target.webSocketDebuggerUrl); }
      catch { return false; }
    });
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise(resolveOpen => socket.addEventListener("open", resolveOpen, { once: true }));
    socket.addEventListener("message", event => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const handler = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) handler.rejectCommand(new Error(message.error.message));
        else handler.resolveCommand(message.result);
      } else if (message.method === "Runtime.exceptionThrown") pageErrors.push(message.params.exceptionDetails.text);
    });
    await command("Runtime.enable");
    await command("Page.enable");
    await command("Page.navigate", { url: `${origin}/index.html` });
    await waitFor(() => evaluate("document.readyState === 'complete' && typeof sampler !== 'undefined' && document.querySelectorAll('.sampler-pad').length === 4"));

    await evaluate(`sampler.importFile(0, ${makeWaveExpression()})`);
    await waitFor(() => evaluate("sampler.serialize().pads[0]?.name === 'example-loop.wav'"));
    evidence.checks.importedAndSerialized = await evaluate("document.querySelectorAll('.sampler-pad')[0].classList.contains('filled') && !document.querySelector('.sampler-export').disabled && sampler.serialize().pads[0].data.startsWith('data:audio/wav;base64,')");
    assert.equal(evidence.checks.importedAndSerialized, true);

    evidence.checks.triggered = await evaluate("sampler.trigger(0) && document.querySelector('.sampler-pad-trigger').classList.contains('playing')");
    assert.equal(evidence.checks.triggered, true);
    evidence.checks.midiPadRoute = await evaluate("(() => { const original = sampler.trigger, pads = []; sampler.trigger = index => { pads.push(index); return false; }; [36, 37, 38, 39].forEach(note => onMIDIMessage({ data: [0x90, note, 100] })); sampler.trigger = original; return JSON.stringify(pads) === JSON.stringify([0, 1, 2, 3]); })()");
    assert.equal(evidence.checks.midiPadRoute, true);

    evidence.checks.exported = await evaluate(`(() => { let objectUrl = null, filename = null; const create = URL.createObjectURL, click = HTMLAnchorElement.prototype.click; URL.createObjectURL = () => (objectUrl = 'blob:sample'); HTMLAnchorElement.prototype.click = function() { filename = this.download; }; sampler.download(0); URL.createObjectURL = create; HTMLAnchorElement.prototype.click = click; return objectUrl === 'blob:sample' && filename === 'example-loop.wav'; })()`);
    assert.equal(evidence.checks.exported, true);
    evidence.checks.malformedDropped = await evaluate("validateSamplerState({ version: 1, pads: [{ data: 'broken', name: 'bad' }] }).pads.every(pad => pad === null)");
    assert.equal(evidence.checks.malformedDropped, true);

    await evaluate(installFakeRecorderExpression());
    await evaluate("sampler.record(1)");
    await waitFor(() => evaluate("document.querySelectorAll('.sampler-pad')[1].classList.contains('recording')"));
    const recordingShot = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
    const recordingPath = resolve(evidenceDir, "sampler-recording.png");
    await writeFile(recordingPath, Buffer.from(recordingShot.data, "base64"));
    evidence.screenshots.push(recordingPath);
    await evaluate("sampler.record(1)");
    await waitFor(() => evaluate("sampler.serialize().pads[1]?.name.startsWith('Recorded pad 2.')"));
    evidence.checks.recordedAndStoppedEarly = await evaluate("sampler.serialize().pads[1] !== null && window.__samplerTest.tracks.length === 1");
    assert.equal(evidence.checks.recordedAndStoppedEarly, true);

    await evaluate("window.__samplerTimeout = window.setTimeout; window.setTimeout = (callback, delay, ...args) => delay === 4000 ? window.__samplerTimeout(callback, 0, ...args) : window.__samplerTimeout(callback, delay, ...args); sampler.record(2)");
    await waitFor(() => evaluate("sampler.serialize().pads[2]?.name.startsWith('Recorded pad 3.')"));
    await evaluate("window.setTimeout = window.__samplerTimeout");
    evidence.checks.autoStoppedAfterCap = await evaluate("sampler.serialize().pads[2] !== null && window.__samplerTest.tracks.length === 2");
    assert.equal(evidence.checks.autoStoppedAfterCap, true);

    evidence.checks.aggregateLimit = await evaluate("sampler.importFile(3, new File([new Uint8Array(MAX_SAMPLER_TOTAL_BYTES)], 'too-large.wav', { type: 'audio/wav' })).then(() => document.getElementById('samplerStatus').textContent.includes('four pads can store up to 2 MB'))");
    assert.equal(evidence.checks.aggregateLimit, true);

    evidence.checks.permissionError = await evaluate("navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Denied', 'NotAllowedError'); }; sampler.record(3).then(() => document.getElementById('samplerStatus').textContent.includes('Microphone blocked'))");
    assert.equal(evidence.checks.permissionError, true);
    await evaluate("window.MediaRecorder = window.__samplerTest.originalMediaRecorder; Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: window.__samplerTest.originalMediaDevices }); delete window.__samplerTest; delete window.__samplerTimeout;");

    for (const width of [375, 768, 1280]) {
      await command("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
      const shot = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
      const path = resolve(evidenceDir, `sampler-${width}.png`);
      await writeFile(path, Buffer.from(shot.data, "base64"));
      evidence.screenshots.push(path);
      evidence.checks[`fits${width}`] = await evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth");
      assert.equal(evidence.checks[`fits${width}`], true);
    }

    await command("Page.navigate", { url: `${origin}/index.html?reload=1` });
    await waitFor(() => evaluate("document.readyState === 'complete' && document.querySelectorAll('.sampler-pad').length === 4"));
    await waitFor(() => evaluate("document.querySelectorAll('.sampler-pad')[0].classList.contains('filled') && document.querySelectorAll('.sampler-pad')[1].classList.contains('filled') && document.querySelectorAll('.sampler-pad')[2].classList.contains('filled')"));
    evidence.checks.restored = await evaluate("sampler.serialize().pads[0]?.name === 'example-loop.wav' && sampler.serialize().pads[1]?.data.startsWith('data:audio/webm;codecs=opus;base64,') && sampler.serialize().pads[2]?.data.startsWith('data:audio/webm;codecs=opus;base64,')");
    assert.equal(evidence.checks.restored, true);
    evidence.checks.noBrowserErrors = pageErrors.length === 0;
    assert.equal(evidence.checks.noBrowserErrors, true);
    evidence.pass = true;
  } finally {
    if (socket) socket.close();
    if (chrome) chrome.kill();
    if (server) await new Promise(resolveClose => server.close(resolveClose));
    await sleep(250);
    try {
      await rm(profile, { recursive: true, force: true });
      evidence.cleanup = { chromeClosed: true, serverClosed: true, profileRemoved: true };
    } catch (error) {
      evidence.cleanup = { chromeClosed: true, serverClosed: true, profileRemoved: false, profileCleanupError: error.code };
    }
    await writeFile(resolve(evidenceDir, "sampler-browser.json"), JSON.stringify(evidence, null, 2) + "\n");
    console.log(JSON.stringify(evidence, null, 2));
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
