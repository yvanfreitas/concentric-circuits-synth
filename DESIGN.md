# Pro-V design contract

## 1. Atmosphere & Identity

Preserve the existing forest-black instrument panel, concentric illuminated dials and compact technical labels. Effects and optional synth sections are first-class modules in the existing grid. There is no separate rack or management section.

## 2. Color

Use existing CSS variables: `--bg-main` #0d0f0d, `--bg-card` rgba(18,22,18,.7), `--bg-input` rgba(255,255,255,.05), `--text-primary` #f0f4f0, `--text-muted` #6b7569, `--border-color` rgba(255,255,255,.08). Dynamic `--accent-color`, `--accent-glow`, `--accent-dim` follow the current synth hue. New effects text uses primary text; muted legacy labels are not a template for new low-contrast copy.

## 3. Typography

Existing families: Outfit (`--ff-sans`) and Share Tech Mono (`--ff-mono`). Reuse `.module-title`, `.module-subtitle`, `.legend-name`, `.legend-value` and the existing toggle styles unchanged.

## 4. Spacing & Layout

Modules occupy ordinary cells in `.modular-grid`, with the same padding, border and drag handle. The dial/legend layout scales from 150px to 112px below 420px so every card fits without horizontal scrolling. The relative order of effect cards determines audio order; intervening synth modules remain layout-only.

## 5. Components

- Module: existing `.module-card`, `.module-header`, `.module-title` and `.module-subtitle` primitives.
- Add action: a discreet `+ Module` selector in the existing header, grouped into synth modules and effects. Active modules are disabled in its options.
- Effect module: actual `ConcentricGaugeDial`, shared legend with scroll/touch adjustment and MIDI Learn, existing bypass toggle treatment, discreet remove icon in the header. No ordering buttons or nested cards.
- Optional synth modules: Oscillator B, Glide & Unison, Lowpass Filter, Filter Envelope, LFO, Poly-Mod, Wheel Mod, MIDI Manager, MIDI Bindings and MIDI Monitor Log. Their existing cards retain state while detached and expose the same discreet remove icon.
- MIDI responsibilities: MIDI Manager owns connection and device selection; MIDI Bindings owns banks and the live learned CC map; MIDI Monitor Log owns the always-visible incoming event stream. Learning through any `LRN` button updates the bindings module immediately.
- Adaptive routes: removing a source/destination also removes its active audio route and hides dependent Mixer, LFO, Poly-Mod and Wheel Mod controls. Wheel Mod is visibly unavailable without the LFO.
- Empty rack: no extra panel; the header selector remains available. Removal returns focus there.

## 6. Motion & Interaction

Use existing dial drag, legend wheel/touch swipe, and MIDI Learn. Reorder only from `.drag-handle`, with touch dragging and Alt + arrow keys on the focusable handle. Hidden native ranges remain keyboard-accessible. Audio changes are smoothed; topology changes fade output for 20ms each side.

## 7. Depth & Surface

Translucent dark modules, thin borders, background radial accent, and the shared dial ring colors. No new shadows or materials.

## 8. Accessibility Constraints & Accepted Debt

Controls have accessible names and visible focus; bypass has text and aria-pressed. Check empty, populated and bypassed states at 375/768/1280px. The user explicitly requested existing module usability and appearance, so their compact labels and dial interactions are retained. Full-site accessibility/performance certification is not claimed.
