# Manual QA — synth-modular-effects

Commit under test: `a0fb2df5f1cc76b234fa9a50722d9254c169dbba`\
Surface: dedicated worktree `C:\\Users\\yvanf\\.codex\\worktrees\\pr1-review-fixes\\concentric-circuits-synth`\
Overall verdict: **PASS**. Confidence: **high** for exercised browser/CLI behavior; no P0/P1 failure or browser page/console error observed. The current-source baseline fixture exits 1 by design because it asserts the historical red error; its captured page error list is empty and the independent LFO current-source scenario is green.

## artifactRefs

| id | kind | description | path |
|---|---|---|---|
| A1 | terminal-transcript | CDP harness unit tests, 5/5 pass | `.omo/evidence/synth-modular-effects/manual-qa-cdp-harness.txt` |
| A2 | terminal-transcript | Effects browser run, all checks pass | `.omo/evidence/synth-modular-effects/manual-qa-effects-browser.txt` |
| A3 | terminal-transcript | LFO browser run, all checks pass | `.omo/evidence/synth-modular-effects/manual-qa-lfo-browser.txt` |
| A4 | terminal-transcript | Sync browser run, all checks pass | `.omo/evidence/synth-modular-effects/manual-qa-sync-browser.txt` |
| A5 | terminal-transcript | Baseline pre-fix characterization, expected red captured | `.omo/evidence/synth-modular-effects/manual-qa-browser-baseline-red.txt` |
| A6 | json-evidence | Baseline pre-fix characterization, exact `ReferenceError: v is not defined` and non-pulse green | `.omo/evidence/synth-modular-effects/manual-qa-browser-baseline-red.json` |
| A7 | terminal-transcript | Current-source baseline probe; expected assertion failure with zero pulse page errors | `.omo/evidence/synth-modular-effects/manual-qa-browser-current.txt` |
| A8 | json-evidence | Current-source baseline probe; `pageErrors=[]`, non-pulse pass, fixture assertion false | `.omo/evidence/synth-modular-effects/manual-qa-browser-current.json` |
| A9 | json-evidence | Effects/rack/runtime checks; 32 binary checks true, cleanup complete | `.omo/evidence/synth-modular-effects/task-4-rack-dsp.json` |
| A10 | json-evidence | LFO checks; modulation, release, propagation, restore, no errors | `.omo/evidence/synth-modular-effects/task-2-lfo.json` |
| A11 | json-evidence | Sync checks; hard-sync resets, native bypass, low-frequency bypass, glide sweep | `.omo/evidence/synth-modular-effects/task-3-sync.json` |
| A12 | source-probe | Read-only HEAD/status and source expression probe | `.omo/evidence/synth-modular-effects/manual-qa-static-source.txt` |
| A13 | screenshot-set | Responsive rack/performance captures at 375/768/1280 plus empty rack | `.omo/evidence/synth-modular-effects/task-5-*.png` |

## surfaceEvidence

| scenario id | criterion reference | surface | exact invocation | verdict | artifactRefs |
|---|---|---|---|---|---|
| P0-01 | harness portability | Node test runner | `node --test test/cdp-harness.test.mjs` | PASS (exit 0; 5/5) | A1 |
| P0-02 | executable discovery absolute-path contract | Node unit test | same invocation; `discoverBrowserExecutable({CHROME_PATH: absolute})` | PASS | A1 |
| P0-03 | invalid relative browser path rejected | Node unit test | same invocation; relative `CHROME_PATH` rejection | PASS | A1 |
| P0-04 | DevTools endpoint parsing | Node unit test | same invocation; `parseDevToolsActivePort` | PASS | A1 |
| P0-05 | idempotent cleanup and primary-error preservation | Node unit test | same invocation; cleanup/error tests | PASS | A1 |
| P0-06 | current production pulse + LFO-to-PW path | CDP browser | `node test/lfo-browser.mjs` | PASS (exit 0; pulse A/B modulation connected, voice released, no page/console errors) | A3,A10 |
| P0-07 | historical regression characterization remains reproducible | CDP browser served in-memory pre-fix source | `SYNTH_BASELINE_SOURCE=pre-fix node test/browser-baseline.mjs` | PASS (exit 0; exact historical `ReferenceError: v is not defined` observed; non-pulse clean) | A5,A6 |
| P0-08 | effects audio correctness | CDP `OfflineAudioContext` | `node test/effects-browser.mjs` | PASS (bypass dry-equivalent, delay/reverb/drive/chorus active output finite/audible/bounded) | A2,A9 |
| P0-09 | no browser runtime errors and teardown | CDP browser + local server | `node test/effects-browser.mjs` | PASS (`noBrowserErrors=true`; server/chrome/profile cleanup true) | A2,A9 |
| P1-01 | MIDI modules separated and learn mapping | CDP browser DOM/runtime | `node test/effects-browser.mjs` | PASS (`midiModulesSeparated`, `learnUpdatesBindings`) | A2,A9 |
| P1-02 | note-source/voice-instance isolation | CDP browser runtime | `node test/effects-browser.mjs` | PASS (live note survives sequencer release; repeated/pending pitch stacks handled) | A2,A9 |
| P1-03 | recorder patch normalization and fallback | CDP browser runtime | `node test/effects-browser.mjs` | PASS (unknown/duplicate module IDs filtered; null modules fallback validated) | A2,A9 |
| P1-04 | recorder rendering coalesces high-frequency events | CDP browser DOM/runtime | `node test/effects-browser.mjs` | PASS (RAF scheduled once; 20 events reflected after frame) | A2,A9 |
| P1-05 | recorder scheduler bounded under dense events | CDP browser runtime | `node test/effects-browser.mjs` | PASS (200 events produce exactly one timer) | A2,A9 |
| P1-06 | per-track recorder patch/context isolation | CDP browser audio/runtime | `node test/effects-browser.mjs` | PASS (2 contexts/inputs; track 1 and track 2 own cutoff/modules) | A2,A9 |
| P1-07 | sequencer edit, piano geometry, and restore visibility | CDP browser DOM/runtime | `node test/effects-browser.mjs` | PASS (49 keys, 784 cells, velocity/note edit, restored active note visible) | A2,A9 |
| P1-08 | sequencer range length 24 preserves note state | CDP browser DOM/runtime | `node test/effects-browser.mjs` | PASS (1176 cells; length=24; selected note preserved) | A2,A9 |
| P1-09 | armed track follows synth parameter edits | CDP browser runtime | `node test/effects-browser.mjs` | PASS (cutoff 5555 copied to armed track patch) | A2,A9 |
| P1-10 | hard sync raw frequency and master-cycle resets | CDP browser audio/runtime | `node test/sync-browser.mjs` | PASS (raw B frequency preserved; reset count advances from master cycles) | A4,A11 |
| P1-11 | sync-off native oscillator behavior | CDP browser audio/runtime | `node test/sync-browser.mjs` | PASS (native stage, one source, zero resets, frequency unchanged) | A4,A11 |
| P1-12 | low-frequency sync bypass | CDP browser audio/runtime | `node test/sync-browser.mjs` | PASS (requested sync becomes native stage; zero resets) | A4,A11 |
| P1-13 | synced pulse glide/coarse-fine sweep | CDP browser audio/runtime | `node test/sync-browser.mjs` | PASS (pulse modulation connected; glide scheduled; frequency sweep/reset count advances) | A4,A11 |
| P1-14 | adaptive dependency removal/re-add | CDP browser DOM/runtime | `node test/effects-browser.mjs` | PASS (OSC B/LFO/filter envelope removed, dependent controls hidden/unavailable, modules re-added) | A2,A9 |
| P1-15 | session, user preset, factory rack preservation | CDP browser storage/runtime | `node test/effects-browser.mjs` | PASS (deep snapshots restored; factory preset keeps rack) | A2,A9 |
| P1-16 | legacy MIDI layout migration | CDP browser DOM/storage | `node test/effects-browser.mjs` | PASS (bindings/monitor inserted adjacent to MIDI module) | A2,A9 |
| P2-01 | responsive rack at 375 px | CDP browser layout + screenshot | `node test/effects-browser.mjs` | PASS (`rackFits375`; no body overflow offenders) | A2,A9,A13 |
| P2-02 | responsive rack at 768 px | CDP browser layout + screenshot | `node test/effects-browser.mjs` | PASS (`rackFits768`; no body overflow offenders) | A2,A9,A13 |
| P2-03 | responsive rack at 1280 px and empty rack cleanup | CDP browser layout + screenshot | `node test/effects-browser.mjs` | PASS (`rackFits1280`, `removedAll`; effect oscillator stop count bounded) | A2,A9,A13 |
| P2-04 | current-source baseline has no historical runtime error | CDP browser current source | `SYNTH_BASELINE_SOURCE=current node test/browser-baseline.mjs` | PASS for behavioral criterion (exit 1 is fixture assertion; captured `pulseScenario.pageErrors=[]`, non-pulse pass; independent A3 exits 0) | A7,A8,A10 |

## adversarialCases

| scenario id | criterion reference | adversarial class | expected behavior | verdict | artifactRefs |
|---|---|---|---|---|---|
| ADV-01 | patch validation | malformed/unknown module IDs and `modules:null` | Ignore invalid entries and fall back to a valid complete module list without throwing | PASS | A2,A9 |
| ADV-02 | voice isolation | repeated same pitch and mixed live/sequencer sources | Releasing one source removes only its own note instances; pending stack decrements one at a time | PASS | A2,A9 |
| ADV-03 | scheduler performance | dense 200-event recorder track | Use a bounded scheduler (one timer), preserve playback state, and cleanly stop | PASS | A2,A9 |
| ADV-04 | sync range edge | sync requested while OSC B is sub-audio/low frequency | Bypass hard-sync safely and use native oscillator with no reset loop | PASS | A4,A11 |
| ADV-05 | dependency churn | remove OSC B/LFO/filter envelope, then re-add modules | Dependent controls hide/disable without errors and become available again after re-add | PASS | A2,A9 |
| ADV-06 | persistence compatibility | legacy MIDI layout + reload + user/factory preset switches | Migrate layout and restore session/preset snapshots without losing rack/performance state | PASS | A2,A9 |
| ADV-07 | responsive boundary | 375 px viewport with wide piano roll | Keep rack controls inside viewport; permit only intentional piano-roll inner scroll | PASS | A2,A9,A13 |
| ADV-08 | fixture polarity | current source passed to red-characterization harness | Report no historical error in evidence; do not mistake fixture assertion exit 1 for a product runtime failure | PASS (page errors empty; independent green current behavior) | A7,A8,A10 |

## execution summary

- Requested commands all executed against the target commit. `cdp-harness.test.mjs`, `effects-browser.mjs`, `lfo-browser.mjs`, and `sync-browser.mjs` exited 0. The default pre-fix baseline exited 0 with its required historical error. The current-source baseline exited 1 only because its assertion requires that historical error; evidence records no page errors.
- All browser JSON cleanup receipts observed `serverStopped/serverClosed=true`, `chromeStopped/chromeClosed=true`, and `profileRemoved=true`.
- No product files were modified; `manual-qa-static-source.txt` records clean git status and the corrected production expressions.
- Blockers: none for the exercised scope.
