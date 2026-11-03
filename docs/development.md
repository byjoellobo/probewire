# Development

## Prerequisites

- **Node.js 22 or newer.** CI uses Node 24.
- npm (bundled with Node).
- For end-to-end tests, a Playwright Chromium build: `npx playwright install chromium`.
- For hardware testing, a Chromium-based browser and a Pico running one of the [supported firmwares](hardware.md). Everything else can be developed with the built-in simulators.

```sh
git clone https://github.com/byjoellobo/probewire.git
cd probewire
npm install
npm run dev
```

The dev server prints a `localhost` URL. Web Serial and WebUSB work on `localhost` without HTTPS.

## Scripts

| Script                 | What it does                                                                 |
| ---------------------- | ---------------------------------------------------------------------------- |
| `npm run dev`          | Vite dev server with hot reload                                              |
| `npm run build`        | Type-check, then production build with the service worker into `dist/`       |
| `npm run preview`      | Serve the production build locally                                           |
| `npm run typecheck`    | `tsc --noEmit`                                                               |
| `npm run lint`         | ESLint                                                                       |
| `npm run format`       | Format all files with Prettier                                               |
| `npm run format:check` | Check formatting without changing files                                      |
| `npm test`             | Unit and integration tests (Vitest)                                          |
| `npm run coverage`     | Tests with a coverage report in `coverage/`                                  |
| `npm run test:e2e`     | Playwright end-to-end and accessibility tests against a production build     |
| `npm run check`        | The checks CI runs before building: lint, format check, type-check and tests |
| `npm run icons`        | Regenerate the PWA icons from `public/logo.svg`                              |

## Project layout

```
src/
  core/         capture model, sample index, measurements, units, signal synthesizer
  decoders/     UART, I2C, SPI decoders, shared types, registry
  drivers/
    serial/     SerialLink byte queue, port picking (Web Serial, WebUSB)
    gusmanb/    gusmanb V6 protocol and device driver
    sigrokPico/ sigrok-pico protocol, stream decoder and device driver
    sim/        FakePort and firmware models for both devices
    demo/       demo scenario and signal-generator device
  formats/      .sr reader and writer, rate strings
  storage/      IndexedDB capture library
  render/       viewport maths, theme, canvas drawing
  app/          Preact UI: App, panels, trace view, hooks, settings
e2e/            Playwright tests
docs/           this documentation
public/         icons and static files
```

[Architecture](architecture.md) explains how the pieces fit together.

## Testing

Probewire is tested at three levels.

**Unit tests** cover pure modules: the sample index (checked against brute force on random data), units and viewport maths, the `.sr` reader and writer, protocol encoders and validators, and the stream decoder. Test files sit next to the code as `*.test.ts`.

**Integration tests** run the real drivers against the firmware models in `src/drivers/sim` over an in-memory `FakePort`. They cover handshakes, captures in every channel mode, bursts, cancellation, device aborts, data loss, and disconnects. Decoders are tested by synthesising signals with `SignalBuilder` (`src/core/synth.ts`) and decoding them back. The storage tests use `fake-indexeddb`.

**End-to-end tests** (`e2e/`) drive a production build in Chromium with Playwright: the first screen, the demo capture, decoders, the simulated analyzers, file import, the phone layout, and an automated accessibility scan with axe on each main view.

Pull requests should keep `npm run check` and `npm run test:e2e` passing and add tests for new behaviour. Coverage is reported in CI; the core, decoder, format, driver and storage modules are expected to stay above 80%.

## Adding a decoder

1. Create `src/decoders/<name>.ts` exporting a `DecoderDef` (see `src/decoders/types.ts`):
   - `channels`: the inputs, each required or optional.
   - `options`: number or select options. Include `DATA_FORMAT_OPTION` so users can switch between hex, decimal, binary and ASCII.
   - `rows`: the annotation rows. Rows whose id ends in `bits` start hidden.
   - `decode(input, channels, options)`: return annotations sorted by start sample, plus human-readable warnings. Annotations within one row must not overlap.
2. Read samples only through `input.pyramid`. Use `findChange`, `findLevel` and `bit` to jump between edges instead of looping over every sample.
3. Give each annotation several `texts`, longest first. The renderer shows the longest one that fits.
4. Register it in `DECODERS` in `src/decoders/registry.ts`.
5. Add name hints for its inputs to `CHANNEL_HINTS` in `src/app/workspace.ts`, so channels are matched automatically.
6. Write tests that synthesise the protocol with `SignalBuilder`, decode it, and check the values, including error cases.
7. Document it in [decoders](decoders.md).

## Adding a driver

1. **Protocol module** (`src/drivers/<device>/protocol.ts`): pure functions to encode commands, parse replies, describe limits and validate a capture config. No I/O, so it is easy to unit test.
2. **Device class** (`src/drivers/<device>/device.ts`): implements `CaptureDevice<Config>` from `src/drivers/types.ts` on top of a `SerialLink`. Every read needs a timeout or an abort signal. Make sure a cancelled or failed capture leaves the device idle.
3. **Firmware model** (`src/drivers/sim/<device>Firmware.ts`): implement `FakeFirmware` so the driver can be tested, and optionally offered in the app as a simulator.
4. **Tests** against the model, including cancellation and malformed replies.
5. **App wiring** in `src/app`:
   - add a `DeviceChoice` and a `Connected` variant in `connection.ts`, with USB filters and control signals;
   - add default settings in `DEFAULT_CONFIGS` and validation in `settings.ts`;
   - add a settings form in `components/CaptureForms.tsx`;
   - add the capture call in `useAnalyzer.ts`.
6. Document the wire protocol in [protocols](protocols.md) and wiring in [hardware](hardware.md).

If the protocol is defined by a GPL project, implement it from a description of the protocol rather than by translating its code, so Probewire stays MIT-licensed.

## Conventions

- **Immutable data.** Captures, configs and decoder setups are never modified in place; updates return new objects. Typed arrays are not written after a capture is built.
- **Small, focused files** (roughly 200 to 400 lines) and small functions.
- **Explicit types** on exported functions; no `any`. Untrusted input (files, device replies, stored settings) is validated at the boundary.
- **Errors are handled, not swallowed.** Messages shown to users say what happened and what to do next.
- **No `console.log`** in committed code.
- **Writing style** in the UI and docs: plain sentence-case text, no marketing language, and no em dash characters.
- **Commits** follow [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, `perf:`, `ci:`.

## Continuous integration

GitHub Actions run on every push and pull request: lint, format check, type-check, unit tests with coverage, the production build, and the Playwright tests. CodeQL scans the code, and Dependabot proposes dependency updates.

Every push to `main` deploys the build to GitHub Pages at https://byjoellobo.github.io/probewire/.

## Releasing

Probewire follows [Semantic Versioning](https://semver.org/). To release version `X.Y.Z`:

1. Update `version` in `package.json` (and run `npm install` so `package-lock.json` matches).
2. In `CHANGELOG.md`, move the entries under **Unreleased** into a new `## [X.Y.Z] - YYYY-MM-DD` section and update the compare links at the bottom.
3. Commit: `chore(release): vX.Y.Z`.
4. Tag and push:

   ```sh
   git tag -a vX.Y.Z -m "Probewire vX.Y.Z"
   git push origin main --tags
   ```

5. The release workflow builds the app, zips `dist/`, and publishes a GitHub Release with that changelog section as its notes and the zip attached. The push to `main` also redeploys GitHub Pages.

The zipped build is a static site: serve it from any HTTPS host to self-host Probewire.
