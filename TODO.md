# TODO

## Sampler: record microphone takes onto pads

**Story**: As a player using the synth, I want to record short microphone takes onto pads in a Sampler module and trigger them while I play, so I can enrich my music with sounds the oscillators can't produce.

**Scope decisions**
- New removable module card `mod-sampler`, registered in `SYNTH_MODULES` like the other modules. Self-contained — does not touch the sequencer or recorder.
- Microphone capture only. No file picker, no drag-and-drop, no `decodeAudioData` of user files.
- Fixed 4 pads, no add/remove pad UI.
- Pads fire on click and on MIDI notes 36–39 (the MPK Mini MK3's own pad bank).
- Pad output connects to `voiceBus`, so pads run through the effects rack alongside the voices.
- 4s hard cap per take. Retriggering a sounding pad restarts it rather than layering.
- Persistence is `localStorage`, storing the compressed `MediaRecorder` Blob as base64 (~35–55KB per 4s take), not raw PCM. No IndexedDB.

**Acceptance criteria**

*Capture*
- [ ] Given the Sampler module is in the rack, when I press Record on an empty pad, then the browser asks for microphone permission and the pad shows a recording state
- [ ] Given I'm recording, when 4 seconds elapse, then recording stops on its own and the take is stored on that pad
- [ ] Given I'm recording, when I press the same pad again, then recording stops early and keeps what was captured
- [ ] Given a pad already holds a take, when I record onto it, then the new take replaces the old one
- [ ] Given I'm recording on one pad, when I press Record on another pad, then the first recording stops and is kept before the second starts

*Permission and failure*
- [ ] Given I deny the microphone prompt, when the Sampler tries to record, then the pad shows a readable "Microphone blocked" state and no pad is left stuck in recording
- [ ] Given no input device is present, when I press Record, then the module says so rather than failing silently
- [ ] Given the page is not on a secure origin, when I press Record, then the module says microphone capture needs HTTPS

*Playback*
- [ ] Given a pad holds a take, when I click it or send its MIDI note, then it plays from the start at recorded pitch
- [ ] Given a pad is already sounding, when it's triggered again, then playback restarts from the beginning
- [ ] Given a pad is empty, when I trigger it, then nothing sounds and nothing throws
- [ ] Given a delay or reverb module is active, when I trigger a pad, then the pad is audible through that effect
- [ ] Given pads are sounding, when I remove the Sampler module from the rack, then all pad audio stops and its nodes are released

*Persistence*
- [ ] Given pads hold takes, when I reload the page, then the same takes are on the same pads and still trigger
- [ ] Given `localStorage` rejects the write on quota, when a take is saved, then the module reports that it couldn't save and the rest of the autosaved state still writes
- [ ] Given a stored payload is malformed or oversized, when the page restores, then the bad pad is dropped and the rest of the app loads normally

*Non-functional*
- [ ] Given a pad is triggered, then no audible glitch is introduced in notes already sounding — decoding happens at capture end and at page load, never at fire time

**Tasks**

- [ ] **Register the module shell.** Add `mod-sampler` to `SYNTH_MODULES`, add the card markup with 4 pad buttons to `mainGrid`, append the id in `restoreLayoutState` for existing saved layouts, and bump `migrateModuleSelection` to version 4 so current users get the module without losing their selection. *(covers: module present in rack, reorderable, removable)*
- [ ] **Microphone capture.** `getUserMedia({ audio: true })` plus `MediaRecorder` into a per-pad Blob: 4s auto-stop, press-again early stop, recording onto a filled pad replaces it, starting a second pad stops and keeps the first. *(covers: all 5 Capture criteria)*
- [ ] **Capture failure states.** Distinguish `NotAllowedError`, `NotFoundError` and a missing `navigator.mediaDevices` (insecure origin) into three readable pad states; guarantee no pad stays stuck in recording on any of them. Errors surface in the UI, never swallowed. *(covers: all 3 Permission and failure criteria)*
- [ ] **Decode and trigger.** `decodeAudioData` once at capture end and once per pad at page load, hold the `AudioBuffer`; trigger creates an `AudioBufferSourceNode` into `voiceBus`; a sounding pad stops its previous source before starting a new one; an empty pad is a no-op. *(covers: 4 of 5 Playback criteria, plus the non-functional criterion)*
- [ ] **MIDI pad trigger.** Route note-on 36–39 in `onMIDIMessage` to the matching pad when the module is active, without disturbing the existing note path. *(covers: trigger by MIDI note)*
- [ ] **Persistence.** Serialize pads as base64 in `saveActiveState`, restore in the load path, and add a `validateSamplerState` mirroring `validateEffectsState` — drop malformed or oversized pads rather than rejecting the whole payload. Catch the quota error on write, report it in the module, and leave the rest of the autosave intact. *(covers: all 3 Persistence criteria)*
- [ ] **Teardown.** In `setSynthModules`, stop sounding pads, stop any in-flight recording, and release the `MediaStream` tracks when `mod-sampler` is removed, matching how the other modules stop their transports. *(covers: removing the module stops pad audio and releases nodes)*
- [ ] **Regression script.** `test/sampler-browser.mjs` driving capture and trigger headlessly with Chrome's `--use-fake-device-for-media-stream` and `--use-fake-ui-for-media-stream`, so the permission path is testable without a real microphone. *(covers: verification of the above)*

**Notes**
- The regression script should reuse the shared CDP harness extracted while fixing the duplication gate on PR #1, not add a fifth copy of it.
- This story depends only on the module registry, which is already on `main`. It does not depend on the sequencer or recorder still in review.
