# Security policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes       |
| older   | No        |

Security fixes are released as patch versions of the latest minor release. The hosted app at https://byjoellobo.github.io/probewire/ always runs the latest build of `main`.

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Report privately through GitHub:

1. Go to the repository's **Security** tab: https://github.com/byjoellobo/probewire/security
2. Choose **Report a vulnerability** and fill in the form.

Include what an attacker could do, the steps or a file that reproduces it, and the browser and version you used. You should get a first response within a week. Once a fix is ready, we will publish a release and a security advisory, and credit you unless you prefer otherwise.

## Scope

Probewire runs entirely in the browser. There is no server, no account and no telemetry.

- Captures, settings and decoder setups stay in the browser's storage on the user's device.
- The only network traffic is loading the app itself (and update checks by the service worker).
- USB access is granted per device by the user through the browser's own permission prompts.

The main attack surface is **untrusted input parsed by the app**:

- **`.sr` files** opened by the user. These are ZIP archives with a text metadata file. Probewire limits file size and decompressed size, ignores unexpected archive entries, and validates metadata, but parsing bugs here are in scope. See [docs/file-format.md](docs/file-format.md).
- **Data from USB devices.** A malicious or faulty device could send arbitrary bytes. Replies are length-checked and validated, and crashes or hangs caused by device data are in scope.
- **Stored settings** in `localStorage`, which are validated on load.

Out of scope:

- Vulnerabilities in browsers, operating systems, USB stacks or the analyzer firmware itself. Report those to their maintainers.
- Physical damage from wiring mistakes, such as applying more than 3.3 V to a Pico pin. See [docs/hardware.md](docs/hardware.md).
- Problems that require an attacker to already control the user's browser or device.
