# Third-party notices

Probewire is released under the [MIT License](LICENSE). The built app bundles the
open-source components below. Their licenses travel with every copy of the build,
including the zip attached to each GitHub release.

| Component                                                                | Version | License                   | Copyright                                 |
| ------------------------------------------------------------------------ | ------- | ------------------------- | ----------------------------------------- |
| [Preact](https://github.com/preactjs/preact)                             | 10.x    | MIT                       | Copyright (c) 2015-present Jason Miller   |
| [fflate](https://github.com/101arrowz/fflate)                            | 0.8.x   | MIT                       | Copyright (c) 2026 Arjun Barrett          |
| [web-serial-polyfill](https://github.com/google/web-serial-polyfill)     | 1.0.x   | Apache-2.0                | Copyright 2019 Google LLC                 |
| [workbox-window](https://github.com/GoogleChrome/workbox)                | 7.x     | MIT                       | Copyright 2018 Google LLC                 |
| [Barlow Semi Condensed](https://github.com/jpt/barlow) (via @fontsource) | 5.x     | SIL Open Font License 1.1 | Copyright 2017 The Barlow Project Authors |

The full license texts are included in each package's `LICENSE` file under
`node_modules/` after `npm install`, and at the links above:

- MIT: https://opensource.org/license/mit
- Apache License 2.0: https://www.apache.org/licenses/LICENSE-2.0
- SIL Open Font License 1.1: https://openfontlicense.org

## Protocols and file formats

Probewire talks to analyzers running third-party firmware and reads and writes a
third-party file format. None of their code is included:

- [gusmanb/logicanalyzer](https://github.com/gusmanb/logicanalyzer) (GPL-3.0): the
  USB protocol was implemented from a description of its behaviour.
- [sigrok-pico](https://github.com/pico-coder/sigrok-pico) (GPL-3.0) and the
  libsigrok `raspberrypi-pico` driver (GPL-3.0-or-later): the serial protocol was
  implemented from a description of its behaviour.
- [libsigrok](https://sigrok.org/wiki/Libsigrok) (GPL-3.0-or-later): the `.sr`
  session format was implemented from its published description and observed
  output, for interoperability with PulseView.

Development-only tools (Vite, TypeScript, ESLint, Vitest, Playwright and others)
are not part of the shipped app.
