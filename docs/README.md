# Probewire documentation

Probewire is a logic analyzer that runs in a browser tab. These guides cover using it, the hardware it talks to, and how it is built.

## Using Probewire

- [Getting started](getting-started.md): open the app, install it, try the demo, capture from real hardware, read and measure waveforms.
- [Hardware](hardware.md): flashing the Pico firmware, wiring, pin maps, limits and troubleshooting.
- [Browser support](browser-support.md): which browsers and devices can reach USB analyzers, and how.
- [Protocol decoders](decoders.md): UART, I2C and SPI options, rows, annotations and CSV export.
- [File format](file-format.md): how `.sr` files are read and written, and what survives a round trip through PulseView.

## How it works

- [Architecture](architecture.md): modules, the capture data model, the sample index, rendering, drivers and storage.
- [Device protocols](protocols.md): the gusmanb V6 and sigrok-pico wire protocols as Probewire speaks them.

## Contributing

- [Development](development.md): setup, scripts, testing, adding decoders and drivers, and the release process.
- [Contributing guide](../CONTRIBUTING.md): bug reports, hardware reports and pull requests.
- [Security policy](../SECURITY.md): how to report a vulnerability.
- [Changelog](../CHANGELOG.md): what changed in each release.
