# Pro-V design contract

## 1. Atmosphere & Identity

Preserve the existing forest-black instrument panel, concentric illuminated dials and compact technical labels. Effects and optional synth sections are first-class modules in the existing grid. There is no separate rack or management section.

## 2. Color

Use existing CSS variables: `--bg-main` #0d0f0d, `--bg-card` rgba(18,22,18,.7), `--bg-input` rgba(255,255,255,.05), `--text-primary` #f0f4f0, `--text-muted` #8a9488 (at least 4.5:1 on every panel surface), `--border-color` rgba(255,255,255,.08), `--border-strong` rgba(255,255,255,.2), `--bg-hover` rgba(255,255,255,.08), `--bg-inset` #050705, `--dial-track` #202820. Borders, fills and text never use raw hex or rgba twins of these tokens. Canvas drawing resolves the same tokens through `canvasTheme`/`cssVar`, because a 2D context ignores `var()`. Dynamic `--accent-color`, `--accent-glow`, `--accent-dim` follow the current synth hue. New effects text uses primary text; muted legacy labels are not a template for new low-contrast copy.

## 3. Typography

Existing families: Outfit (`--ff-sans`) for labels and buttons, Share Tech Mono (`--ff-mono`) for values, readouts and status. Four sizes only: `--fs-micro` 10px, `--fs-ui` 11px, `--fs-title` 13px, `--fs-brand` 20px. Module headers use only the uppercase `.module-title`; secondary subtitle copy is intentionally omitted. Reuse `.legend-name`, `.legend-value` and the existing toggle styles unchanged.

## 4. Spacing & Layout

Modules occupy ordinary cells in `.modular-grid`, with the same padding, border and drag handle. The dial/legend layout scales from 150px to 112px below 420px so every card fits without horizontal scrolling; every dial draws and hit-tests in a 150-unit space scaled to its rendered size. Below 600px the on-screen keyboard shows ten white keys and relies on Octave Shift for range. Radii come from `--radius-sm` 4px, `--radius-md` 6px, `--radius-lg` 8px and `--radius-pill`. The relative order of effect cards determines audio order; intervening synth modules remain layout-only.

## 5. Components

- Module: existing `.module-card`, `.module-header` and `.module-title` primitives, without subtitle copy. Toggles sit below the dial.
- Controls: momentary actions use `.hdr-btn` (one shared hover); stateful switches use `.button-toggle`, whose label names the function while the LED and `aria-pressed` carry the state; every `select` shares one treatment; field and group labels use `.voices-label`.
- Destructive actions: no native confirm. The action runs at once and the undo bar offers a single-slot Undo for 8 seconds (replacing a recorded take keeps it until the new take stops). Covers clearing the sequencer, shortening the roll, clearing or removing a track, recording over a take, replacing a sampler pad, and overwriting or deleting a preset.
- Add action: a discreet `+ Module` selector in the existing header, grouped into synth modules and effects. Active modules are disabled in its options.
- Effect module: actual `ConcentricGaugeDial`, shared legend with scroll/touch adjustment and MIDI Learn, the standard toggle labelled Enabled, discreet remove icon in the header. No ordering buttons or nested cards.
- Optional synth modules: Oscillator B, Glide & Unison, Lowpass Filter, Filter Envelope, LFO, Poly-Mod, Wheel Mod, MIDI Manager, MIDI Bindings and MIDI Monitor Log. Their existing cards retain state while detached and expose the same discreet remove icon.
- Sampler module: four compact pads use the existing module-card, input-surface, border and mono-label primitives. Each pad has a clear trigger, REC, IMPORT and EXPORT action; its metadata names the MIDI pad and loaded sample state without introducing a separate file-management surface.
- MIDI responsibilities: MIDI Manager owns connection and device selection; MIDI Bindings owns banks and the live learned CC map while present; MIDI Monitor Log owns the incoming event stream while that optional module is present. Learning through any `LRN` button updates the bindings module immediately.
- Performance modules: Sequencer and MIDI Recorder span the full grid width while retaining the standard module header, drag handle and remove action. Their dense controls use the existing input, toggle, mono-label and accent treatments instead of introducing a new visual layer.
- Sequencer: a piano-roll surface inspired by DAW editors, with a vertical keyboard/pitch legend and a user-entered roll length from 1 to 128 steps. Notes render as accent blocks at the pitch/time intersection; keyboard keys audition notes, grid cells program them, and velocity/gate remain in the focused editor. Active and currently playing columns remain distinguishable without relying on animation alone. Clear resets note content while preserving roll length and timing.
- MIDI Recorder: a compact transport above a track list. Each track exposes arm, mute, solo, rename, clear, event count, removal and a miniature pitch/time preview of its captured note events. Tracks store MIDI events plus a live synth patch snapshot, never rendered audio. Recording captures the initial patch; selecting or arming applies it to the synth; subsequent edits update that active track; multitrack playback isolates every snapshot in its own voice and effects path while leaving the selected controls unchanged. Clearing a track preserves its name and patch.
- Adaptive routes: removing a source/destination also removes its active audio route and hides dependent Mixer, LFO, Poly-Mod and Wheel Mod controls. Wheel Mod is dimmed, labelled "needs LFO" and inert without the LFO.
- Empty rack: no extra panel; the header selector remains available. Removal returns focus there.

## 6. Motion & Interaction

Use existing dial drag, legend wheel/touch swipe, and MIDI Learn. Reorder only from `.drag-handle`, with touch dragging and Alt + arrow keys on the focusable handle. Hidden native ranges remain keyboard-accessible. Audio changes are smoothed; topology changes fade output for 20ms each side.

## 7. Depth & Surface

Translucent dark modules, thin borders, background radial accent, and the shared dial ring colors. No new shadows or materials.

## 8. Accessibility Constraints & Accepted Debt

Controls have accessible names and one accent focus ring; hidden parameter ranges are named and show focus on their legend row; toggles and waveform buttons expose `aria-pressed`. Motion is disabled under `prefers-reduced-motion`. Labels at 10px remain accepted debt. Check empty, populated and bypassed states at 375/768/1280px. The user explicitly requested existing module usability and appearance, so their compact labels and dial interactions are retained. Full-site accessibility/performance certification is not claimed.
