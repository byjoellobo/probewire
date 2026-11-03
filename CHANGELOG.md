# Changelog

All notable changes to Probewire are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-11-03

First public release. Device support is verified against detailed models of both firmwares; it has not yet been verified on physical boards.

### Added

#### Capture

- gusmanb Logic Analyzer driver for firmware V6 and newer:
  - up to 24 channels;
  - 8-, 16- and 24-channel modes, chosen automatically;
  - edge, pattern, fast-pattern and blast triggers, with latency compensation for pattern triggers;
  - burst captures with measured gaps between bursts;
  - cancellation that leaves the analyzer idle.
- sigrok-pico driver:
  - 21, 26 or 32 digital channels and up to 3 analog channels;
  - streamed capture in both compact and general encodings, including run-length data;
  - device rate rules applied automatically;
  - data-loss detection from the end-of-capture byte count.
- Two connection methods: Web Serial, and a WebUSB fallback through web-serial-polyfill for Android phones without wired Web Serial.
- Settings forms that check values against the connected analyzer's limits before capturing.
- Unplug detection, and clear errors for busy ports, silent devices, old firmware and buffer overruns.

#### Try without hardware

- Signal generator producing up to 50 million samples of UART, I2C, SPI, PWM and clock traffic.
- Simulated gusmanb and sigrok-pico analyzers that run the real drivers against firmware models.

#### Viewing and measuring

- Waveform view whose drawing cost depends on screen width, not capture length, backed by a multi-level OR/AND sample index.
- Pan, zoom, pinch and keyboard navigation, with exact edges and sample points at deep zoom.
- Keyboard measuring: `A` and `B` drop cursors, `X` clears them, and decoded values open from the table with Enter.
- Accessibility: AA-level text and control contrast, visible focus, a skip link, screen-reader announcements for capture progress and cursor measurements, and ARIA tabs with arrow-key navigation. Every release runs automated axe (WCAG 2.1 AA) checks in CI.
- Analog channels drawn as min/max envelopes.
- Time ruler relative to the trigger, with trigger and burst markers.
- Cursors A and B with time difference and frequency.
- Pulse measurement under the pointer: level, width, period, frequency and duty cycle.
- Channel renaming.

#### Decoding

- UART decoder:
  - 5 to 9 data bits, five parity modes, 1, 1.5 or 2 stop bits;
  - MSB-first and inverted lines;
  - parity, framing and break detection.
- I2C decoder: 7- and 10-bit addresses, repeated starts, ACK/NACK, and per-transaction summaries.
- SPI decoder: all four modes, word sizes from 4 to 32 bits, optional chip select, partial-word warnings and per-transfer summaries.
- Automatic channel matching by name, annotation rows that can be shown or hidden, a values table with jump-to, and CSV export.
- Hex, decimal, binary and ASCII display.

#### Files and storage

- sigrok `.sr` import and export compatible with PulseView 0.4 and libsigrok 0.5, including analog channels and older file variants.
- Size limits and entry filtering when opening untrusted `.sr` files.
- Capture library in IndexedDB, with decoder setups saved per capture, atomic saves, rename, delete and export.
- Opening files by drag and drop, and as an installed app's file handler.

#### App

- Installable progressive web app that works offline, with an update prompt.
- Responsive layout with a bottom sheet and tab bar on phones.
- Documentation covering usage, hardware, browser support, decoders, the file format, protocols, architecture and development.
- CI with linting, type-checking, unit, integration and end-to-end tests, accessibility checks, CodeQL, deployment to GitHub Pages and automated releases.

[Unreleased]: https://github.com/byjoellobo/probewire/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/byjoellobo/probewire/releases/tag/v0.1.0
