# Architecture

Probewire is a static single-page app: Preact for the interface, TypeScript throughout, Vite for the build and vite-plugin-pwa for offline support. There is no server; everything runs in the browser.

## Data flow

```
 Pico analyzer                         .sr file
      |  USB                               |
      v                                    v
 Web Serial / WebUSB polyfill        formats/srzip.ts
      |  PortLike                          |
      v                                    |
 drivers/serial/link.ts  (byte queue)      |
      |                                    |
      v                                    |
 drivers/gusmanb | drivers/sigrokPico      |
      |                                    |
      +-------------> Capture <------------+
                         |
                         v
              core/pyramid.ts (sample index)
                 |                 |
                 v                 v
         render/draw.ts      decoders/*.ts --> annotations
                 |                 |
                 +------> app (Preact UI) <---> storage/db.ts (IndexedDB)
```

## Module map

| Folder                   | Responsibility                                                                                                                                 |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core`               | The capture model, the sample index (`pyramid.ts`), pulse measurements, unit formatting, and the signal synthesizer used by tests and the demo |
| `src/decoders`           | UART, I2C and SPI decoders, their shared types, and the registry                                                                               |
| `src/drivers/serial`     | `SerialLink`, a byte-stream reader over any port, and port picking for Web Serial and WebUSB                                                   |
| `src/drivers/gusmanb`    | The gusmanb V6 protocol (framing, capture request, limits) and the device driver                                                               |
| `src/drivers/sigrokPico` | The sigrok-pico protocol (commands, stream decoder) and the device driver                                                                      |
| `src/drivers/sim`        | An in-memory fake port and behavioural models of both firmwares                                                                                |
| `src/drivers/demo`       | The demo scenario and the signal-generator device                                                                                              |
| `src/formats`            | The `.sr` reader and writer, and sigrok-style rate strings                                                                                     |
| `src/storage`            | The IndexedDB capture library                                                                                                                  |
| `src/render`             | Viewport maths, colours and canvas drawing                                                                                                     |
| `src/app`                | The Preact interface: panels, trace view, hooks and settings                                                                                   |

Code outside `src/app` and `src/render/draw.ts` does not touch the DOM, which is why most of it can be tested in Node.

## The capture model

A capture (`src/core/capture.ts`) is an immutable object:

- **Logic samples** are packed: one unsigned word per sample, where bit _n_ is the level of channel _n_. Words are 8, 16 or 32 bits wide depending on the highest channel used. This is also sigrok's on-disk layout, so `.sr` import and export are plain copies.
- **Channels** map a bit index to a name.
- **Analog channels** hold one `Float32Array` per channel on the same timebase.
- Optional **trigger sample**, **burst starts** and **burst gaps** come from the device.

Captures are never modified in place. Renaming a channel produces a new capture object that shares the same sample arrays.

## The sample index

Captures can hold tens of millions of samples, and both drawing and decoding need fast answers to "what happens in this range?". `LogicPyramid` (`src/core/pyramid.ts`) answers that for every channel at once.

For each block of 32 samples it stores two words: the bitwise **OR** of all samples in the block and the bitwise **AND**. The next level summarises 4 blocks of the level below, and so on until one block covers the whole capture. For channel bit _b_ in a block:

- OR bit clear: the channel was **low** throughout.
- AND bit set: the channel was **high** throughout.
- Otherwise the channel **changed** inside the block.

### A worked example

Take 8 samples of two channels (bit 0 and bit 1) and, to keep it small, blocks of 4:

| Sample | 0   | 1   | 2   | 3   | 4   | 5   | 6   | 7   |
| ------ | --- | --- | --- | --- | --- | --- | --- | --- |
| bit 1  | 1   | 1   | 1   | 1   | 0   | 0   | 1   | 1   |
| bit 0  | 0   | 0   | 0   | 0   | 0   | 1   | 0   | 1   |

| Block               | OR   | AND  | bit 1           | bit 0          |
| ------------------- | ---- | ---- | --------------- | -------------- |
| samples 0 to 3      | `10` | `10` | high throughout | low throughout |
| samples 4 to 7      | `11` | `00` | changes         | changes        |
| level above, 0 to 7 | `11` | `00` | changes         | changes        |

To ask "is bit 0 ever high in samples 0 to 3?" Probewire reads one word instead of four samples. Any range is answered by combining the largest aligned blocks that fit inside it, falling back to raw samples only at the ragged ends. The cost is logarithmic in the range length.

The same blocks power edge searches. `findChange`, `findLevel` and `findPrevChange` skip whole blocks whose OR and AND show that nothing relevant changes. Decoders use them to jump across idle stretches, so a sparse UART line in a 10 million sample capture decodes in tens of milliseconds.

Memory overhead is two 32-bit words per 32 samples at the bottom level plus a third of that for the levels above: about 1/16 of a 32-bit capture. `AnalogPyramid` does the same with min and max values for analog channels.

## Rendering

The trace view (`src/app/components/TraceView.tsx`) draws on two canvases with the Canvas 2D API: the time ruler and the rows.

- **Zoomed out** (one or more samples per pixel), the renderer takes the OR and AND of each pixel column's sample range from the index, once for all channels. Each logic row then reads its own bit: low, high, or changed. Changed columns are drawn as solid bars, which is what a dense signal looks like at that zoom.
- **Zoomed in** (less than one sample per pixel), it draws exact edges from the raw samples. From 12 pixels per sample, it also marks each sample point.
- **Analog rows** draw a min/max envelope per column.
- **Decoder rows** find the first visible annotation by binary search and draw from there. Annotations narrower than 3 pixels merge into a single bar, so dense traffic stays fast and readable. Each annotation shows the longest label that fits.

The work per frame depends on the canvas width, not on the capture length. That is why Canvas 2D is enough, and WebGPU is not used.

The viewport (first sample and samples per pixel) lives in a ref, and redraws are scheduled with `requestAnimationFrame`, so panning and zooming never re-render the Preact tree. Only the rows inside the scrolled area are drawn. Canvases are sized for the device pixel ratio.

## Decoding

Decoders are pure functions: `decode(input, channels, options)` returns sorted annotations and warnings. They read samples only through the `LogicPyramid`, have no access to the DOM, and keep no global state.

The app runs them on the main thread, one decoder per task so input stays responsive between decoders, and caches each result by capture id and decoder configuration. Changing one option re-runs only that decoder.

## Drivers

Drivers depend on a small `PortLike` interface: `open`, `close`, `readable`, `writable` and optionally `setSignals` and `getInfo`. Three things satisfy it:

1. A real Web Serial `SerialPort`.
2. The WebUSB polyfill's port, for Android.
3. `FakePort` from `src/drivers/sim`, an in-memory port with pluggable firmware.

`SerialLink` (`src/drivers/serial/link.ts`) runs a background pump that moves incoming chunks into a queue. Protocol code then asks for a line, an exact number of bytes, text matching a pattern, or everything until the line goes quiet. Every read takes a timeout and an `AbortSignal`. Unrecoverable read errors (such as an unplug) become `LinkClosedError`. Recoverable ones (buffer overrun, framing) increment a loss counter, and any binary read in progress fails with `DataLossError` rather than returning misaligned data.

Each device class exposes the same small contract (`src/drivers/types.ts`): a summary for the Device panel, `capture(config, { signal, onProgress })` returning a capture plus warnings, and `close()`.

### Simulators

`src/drivers/sim` contains behavioural models of both firmwares, written from their protocol descriptions. They parse commands, enforce the same limits, encode samples the same way, and can inject faults (rejected captures, aborts, dropped bytes). The driver tests run against them, and the app offers them as **Simulated gusmanb analyzer** and **Simulated sigrok-pico**, so the code path that talks to hardware also runs in a plain browser tab.

## Storage

The library lives in an IndexedDB database named `probewire`:

| Store      | Key                                    | Contents                                                                                                                |
| ---------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `captures` | capture id                             | Metadata: name, dates, rate, sample count, channels, analog names, trigger, bursts, source, size and the decoder setups |
| `chunks`   | `<id>:L:<n>` and `<id>:A<channel>:<n>` | Sample data in 8 MiB chunks, logic and analog separately                                                                |

Keeping metadata apart from samples means the library list loads without reading megabytes of data. Saves and deletes run in a single transaction across both stores, so a failure (for example a full disk) leaves the previous version intact. Loads read chunks straight into the final typed arrays.

Settings (device choice, connection method, capture configs, decoders, auto-save) are stored in `localStorage` under `probewire:settings:v1` and validated on load.

## Offline support

vite-plugin-pwa generates a Workbox service worker that precaches the app shell, scripts, styles, icons and the self-hosted font files. After the first visit, Probewire loads without a network connection. Updates use the "prompt" strategy: when a new version is available, the app shows a message with a **Reload** button instead of switching versions mid-session.

The web app manifest declares a file handler for `.sr` files. Where the browser supports it, opening a `.sr` file with the installed app passes it to Probewire through the Launch Queue API.
