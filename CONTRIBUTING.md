# Contributing to Probewire

Thanks for helping. Probewire is a small project, and bug reports, hardware reports, documentation fixes and code are all welcome.

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to help

### Report a bug

[Open a bug report](https://github.com/byjoellobo/probewire/issues/new?template=bug_report.yml). Include:

- what you did, what you expected and what happened instead;
- the browser and version, the operating system, and the device;
- the analyzer and firmware version, if hardware was involved;
- a `.sr` file that shows the problem, if it is about decoding or display.

Please search existing issues first. For security problems, do **not** open a public issue; follow the [security policy](SECURITY.md).

### Test with real hardware

Version 0.1.0 has been verified against detailed models of the gusmanb and sigrok-pico firmwares, but not yet on physical boards. Reports from real hardware are the most valuable contribution right now, whether everything worked or not.

[Open a hardware report](https://github.com/byjoellobo/probewire/issues/new?template=hardware_report.yml) with the board, firmware build, browser, connection method and settings you used. Attaching a `.sr` capture of a known signal (a UART line, an I2C bus, a PWM output) makes it easy to check the results.

### Suggest a feature

[Open a feature request](https://github.com/byjoellobo/probewire/issues/new?template=feature_request.yml) describing the problem you want solved, not only the solution. New decoders and new analyzer drivers are in scope; anything that needs a server is not.

### Improve the docs

Docs live in [`docs/`](docs/README.md). Small fixes can go straight to a pull request.

## Development setup

See [docs/development.md](docs/development.md) for prerequisites, scripts, the project layout, testing, and guides to adding decoders and drivers. In short:

```sh
npm install
npm run dev
npm run check      # lint, format check, type-check, tests
npm run test:e2e   # Playwright tests
```

## Pull requests

1. Fork the repository and create a branch from `main`, named for the change: `fix/i2c-repeated-start`, `feat/can-decoder`, `docs/hardware-zero-pinout`.
2. Keep each pull request to one change. Open an issue first for anything large, so we can agree on the approach.
3. Add or update tests. Bug fixes should come with a test that fails without the fix.
4. Run `npm run check` and `npm run test:e2e` before pushing.
5. Update the docs and add a line under **Unreleased** in [CHANGELOG.md](CHANGELOG.md) for user-visible changes.
6. Open the pull request and fill in the template. CI must pass before merging.

### Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>: <short description>

<optional body explaining why>
```

Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `perf`, `ci`.

### Code style

- TypeScript with explicit types on exported functions and no `any`.
- Immutable data: return new objects instead of modifying existing ones.
- Validate untrusted input (files, device replies, stored settings) where it enters the app.
- No `console.log` in committed code.
- Formatting is handled by Prettier and checked in CI; run `npm run format`.
- In UI text and docs: plain sentence-case wording, and no em dash characters.

### Licensing of contributions

Probewire is MIT-licensed. By submitting a pull request you agree that your contribution is licensed under the same terms. No contributor license agreement or DCO sign-off is required.

Please do not copy code from GPL-licensed projects such as libsigrok, libsigrokdecode, sigrok-pico or gusmanb/logicanalyzer. Implementing a protocol from its description is fine; translating their source is not, because it would bring GPL obligations into the project.

## Questions

Open a [discussion or issue](https://github.com/byjoellobo/probewire/issues) if something is unclear. There are no silly questions about logic analyzers.
