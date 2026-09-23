import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createIdempotentCleanup,
  discoverBrowserExecutable,
  parseDevToolsActivePort,
  runWithCleanup
} from "./cdp-harness.mjs";

test("discoverBrowserExecutable returns an absolute configured executable", async t => {
  // Given
  const directory = await mkdtemp(join(tmpdir(), "cdp-harness-test-"));
  const executable = join(directory, "chrome-test.exe");
  await writeFile(executable, "browser fixture");
  t.after(() => rm(directory, { recursive: true, force: true }));

  // When
  const discovered = await discoverBrowserExecutable({ CHROME_PATH: executable });

  // Then
  assert.equal(discovered, executable);
});

test("discoverBrowserExecutable rejects a relative configured executable", async () => {
  // Given
  const environment = { CHROME_PATH: "chrome.exe" };

  // When / Then
  await assert.rejects(
    discoverBrowserExecutable(environment),
    /CHROME_PATH must be an absolute path/
  );
});

test("parseDevToolsActivePort parses an ephemeral loopback endpoint", () => {
  // Given
  const contents = "54321\n/devtools/browser/session-id\n";

  // When
  const endpoint = parseDevToolsActivePort(contents);

  // Then
  assert.deepEqual(endpoint, {
    port: 54321,
    browserWebSocketUrl: "ws://127.0.0.1:54321/devtools/browser/session-id"
  });
});

test("createIdempotentCleanup runs each disposer once and reports failures", async () => {
  // Given
  const calls = [];
  const cleanup = createIdempotentCleanup([
    ["profile", async () => { calls.push("profile"); }],
    ["browser", async () => { calls.push("browser"); throw new Error("browser cleanup failed"); }]
  ]);

  // When
  const first = await cleanup();
  const second = await cleanup();

  // Then
  assert.strictEqual(second, first);
  assert.deepEqual(calls, ["browser", "profile"]);
  assert.equal(first.complete, false);
  assert.deepEqual(first.completed, { browser: false, profile: true });
  assert.match(first.errors.browser, /browser cleanup failed/);
});

test("runWithCleanup preserves the primary failure when cleanup also fails", async () => {
  // Given
  const primary = new Error("scenario failed");
  const cleanup = async () => ({
    complete: false,
    completed: { browser: false },
    errors: { browser: "cleanup failed" }
  });

  // When / Then
  await assert.rejects(
    runWithCleanup(async () => { throw primary; }, cleanup),
    error => error === primary
      && error.harnessCleanup.complete === false
      && error.harnessCleanup.errors.browser === "cleanup failed"
  );
});
