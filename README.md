# Pro-V — Concentric Arc Edition

Browser synthesizer modeled after the Sequential Prophet-5 / Oberheim OB-Xa lineage, built for the Akai MPK Mini MK3. Single HTML file, no build step, no framework — vanilla JS and the Web Audio API.

Live: https://midi-synth.ew.codes — also reachable at the raw Cloud Run URL, https://mpk-prophet5-synth-zruulhtwoa-uc.a.run.app

## Features

- Two oscillators (sine/triangle/sawtooth/pulse) + noise, with coarse/fine detune, low-freq mode and hard sync on Osc B
- Multi-mode filter (key tracking, resonance, envelope amount)
- Dedicated filter and amp ADSR envelopes
- LFO routable to Osc A/B, pulse width, or filter
- Poly-Mod (filter env → Osc B/PW/filter, Osc B → freq A/PW/filter)
- Mod wheel routable to pitch or filter
- Glide and unison (detune spread)
- Drag-and-drop modular UI — reorder module cards, layout persists
- 40 factory presets across categories (Teclas, Baixos, Leads, Pads, FX & Percussão, Músicas — the last are patches inspired by well-known synth sounds, named after the song)
- Full MIDI Learn: any CC maps to any parameter, two banks (A/B) of 8 slots each, mapping persists in `localStorage`
- On-screen keyboard with octave shift, works with mouse/touch or MIDI in
- Optional Google Analytics (see below) — fully disabled unless a Measurement ID is present

## Architecture

Everything lives in `index.html`: styles, markup, and the synth engine in one file, on purpose — this is meant to be copy-pastable and hackable without a toolchain. The rough shape:

- **`P`** — a single flat object holding every synth parameter (oscillators, filter, envelopes, LFO, poly-mod, wheel, glide/unison, master). This is the source of truth; UI controls read from and write to it.
- **Audio graph** — built once against a `Web Audio` `AudioContext` (osc A/B + noise → mixer → filter → amp env → master), with a per-voice envelope generator for filter and amp.
- **Concentric dial UI** — each module card renders its knobs as concentric arcs on a `<canvas>`, driven by the same `P` values; there's no separate widget library.
- **`factoryPresets`** (near the end of the script) — a plain object of `{ name: { ...paramValues } }`. `applyPreset()` merges a preset into `P`, updates every input/select/toggle to match, and redraws the dials.
- **`presetCategories`** — an ordered map of category label → preset names, used only to group the dropdown. A preset not listed there falls back to an "Outros" group, so nothing silently disappears.
- **MIDI Learn** — `ccMaps` holds CC-number → parameter-name mappings per bank; `onMIDIMessage` looks up the mapping and writes straight into `P`. Click a "LRN" button, turn a knob, done.
- **Persistence** — active patch, layout order, and CC maps are autosaved to `localStorage` so a page refresh doesn't lose your session.

## Running locally

No dependencies, no build. Open `index.html` directly in a browser, or serve it:

```bash
npx serve .
```

Connect a MIDI controller before loading the page (browsers only enumerate devices present at `requestMIDIAccess` time on some platforms) — the MIDI Manager card lets you reconnect without a reload either way.

## Deployment

`Dockerfile` + `nginx.conf` package `index.html` behind nginx, listening on Cloud Run's `$PORT`. `.github/workflows/deploy.yml` deploys to Cloud Run automatically on every push to `master` via `gcloud run deploy --source .`. Production tracks `master` — there's no separate staging step, so land changes there only when they're ready to ship.

Auth uses a dedicated GCP service account (`github-deployer`) scoped to just this project, holding only the roles needed to build and deploy (`run.admin`, `iam.serviceAccountUser`, `cloudbuild.builds.editor`, `artifactregistry.writer`, `storage.admin`). Its key lives only as the `GCP_SA_KEY` GitHub Actions secret.

### Custom domain

The service is served at `midi-synth.ew.codes` through a **Cloud Run domain mapping** (`us-central1`), not a load balancer:

```bash
gcloud beta run domain-mappings create \
  --service mpk-prophet5-synth \
  --domain midi-synth.ew.codes \
  --region us-central1 \
  --project synth-prophet5-82941
```

DNS is a single `CNAME` at GoDaddy: `midi-synth` → `ghs.googlehosted.com.` `ew.codes` is already verified for the account, and Google issues/renews the TLS certificate automatically (issuance takes ~15 minutes, though the cert can take a while to roll out to every edge). Mappings are attached to the *service*, so redeploying revisions does not disturb the domain.

Two caveats worth knowing: domain mappings are a **Preview** feature that Google [does not recommend for production](https://docs.cloud.google.com/run/docs/mapping-custom-domains) (it points to a global external Application Load Balancer instead), and TLS 1.0/1.1 cannot be disabled on a mapping. For a single-file hobby synth behind no auth, neither matters.


## Analytics (optional)

If you fork this and want your own usage analytics, `setup-analytics.js` is a one-shot local script that authenticates via `gcloud auth login --update-no-cache --scopes=...,https://www.googleapis.com/auth/analytics`, creates a GA4 property + web stream, and writes the resulting Measurement ID into the `<meta name="ga-measurement-id">` tag in `index.html`. Run it with `node setup-analytics.js`. Nothing is sent anywhere until that meta tag has a real ID — the ID is only ever read from that tag, no query-param or `localStorage` override.

## Contributing

This is a single-file hobby project — keep changes proportional to that.

1. Fork, branch off `master`.
2. Edit `index.html` directly. Match the existing style: no build tooling, no external dependencies, no framework.
3. If you're adding or changing a **factory preset**: put every key from an existing preset object (partial presets aren't supported — `applyPreset()` merges into whatever `P` already holds, so a missing key leaks the previous patch's value) and add its name to `presetCategories` under the right group, or it'll land in "Outros".
4. If you're adding a **new parameter**: add it to `P` with a sensible default, wire an input for it, add it to every existing factory preset (see previous point), and add it to `RANGES`/enum validation if you're scripting a sanity check.
5. Test in an actual browser with a MIDI controller if you touch anything MIDI-related — there's no automated test suite for the audio/MIDI path.
6. Open a PR against `master`. Since `master` auto-deploys to production on merge, please describe what you tested (which browser, with/without MIDI) in the PR description.

Bug reports and preset contributions (especially more song-inspired patches) are welcome as issues or PRs.
