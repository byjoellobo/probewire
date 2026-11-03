# File format

Probewire saves and opens sigrok session files (`.sr`, also called "srzip" v2). These are the native files of [PulseView](https://sigrok.org/wiki/PulseView) and [sigrok-cli](https://sigrok.org/wiki/Sigrok-cli), so captures move freely between the tools.

The reader and writer (`src/formats/srzip.ts`) were written from a description of the format and share no code with libsigrok.

## What Probewire writes

A `.sr` file is a ZIP archive. Probewire writes it the way libsigrok 0.5.2 does:

| Entry                               | Contents                                                          |
| ----------------------------------- | ----------------------------------------------------------------- |
| `version`                           | The single byte `2`, no newline                                   |
| `metadata`                          | An INI-style key file, described below                            |
| `logic-1-1`, `logic-1-2`, ...       | Logic samples in chunks of 4 MiB                                  |
| `analog-1-N-1`, `analog-1-N-2`, ... | Analog samples for channel key `N`, in chunks of 1,048,576 values |

Entries under 64 bytes are stored; sample data is deflated. Compression runs in a worker so large saves do not freeze the page.

### Metadata

For 8 logic channels at 1 MHz, Probewire writes:

```ini
[global]
sigrok version=0.5.2

[device 1]
capturefile=logic-1
total probes=8
samplerate=1 MHz
total analog=0
probe1=D0
probe2=D1
probe3=D2
probe4=D3
probe5=D4
probe6=D5
probe7=D6
probe8=D7
unitsize=1
```

- `total probes` is the highest channel index plus one, so a capture with a gap in its channels still keeps every channel on its original bit.
- `probeN` names channel bit `N - 1`. Channels that were not captured get no `probeN` key.
- `samplerate` uses sigrok's formatting: `500 kHz`, `1 MHz`, `12.5 MHz`, `33.333333 MHz`. The space before the unit matters: sigrok reads `12.5MHz` as 12 Hz.
- `analogN` keys continue numbering after the logic probes. With 16 logic probes, the first analog channel is `analog17` and its data is in `analog-1-17-1`.
- `unitsize` is the number of bytes per logic sample: the number of probes divided by 8, rounded up. 24 channels use 3 bytes per sample, as in sigrok.
- Channel names are trimmed, have line breaks removed, and are escaped the way GLib's key files expect (backslashes, leading spaces).

### Sample data

- **Logic:** `unitsize` bytes per sample, little-endian; bit `i` is channel `i`.
- **Analog:** 32-bit floats, little-endian, in volts.

## What Probewire accepts

On import Probewire is more lenient than it is on export:

- Version `1` and `2` files.
- Key files with spaces around `=`, Windows line endings, and `#` or `;` comments, as written by older sigrok versions.
- Logic data in numbered chunks (`logic-1-1`, `logic-1-2`, ...) or as a single unchunked `logic-1` entry.
- Analog-only sessions with no logic channels.
- Sample rates written loosely (`2m`, `48000`, `12.5MHz`).

It warns, rather than failing, when:

| Situation                                             | What happens                         |
| ----------------------------------------------------- | ------------------------------------ |
| The file has more than one device                     | Only the first is loaded.            |
| There is no sample rate                               | 1 MHz is assumed.                    |
| There are more than 32 logic probes                   | Only the first 32 are loaded.        |
| The logic data length is not a multiple of `unitsize` | The final partial sample is dropped. |
| A declared analog channel has no data                 | That channel is skipped.             |
| Analog values are NaN or infinite                     | They are set to 0.                   |
| Channels have different lengths                       | All are trimmed to the shortest.     |

### Limits on untrusted files

A `.sr` file is a ZIP archive and could be crafted to expand to far more data than its size suggests. To protect the browser tab:

- Files larger than 1 GB are refused before they are read.
- Only entries that belong to a session (`version`, `metadata`, `logic-*`, `analog-*`) are decompressed; anything else in the archive is ignored.
- If the declared uncompressed size of those entries exceeds **1.5 GB**, the file is refused.
- File names inside the archive are looked up as plain data, never through object properties.

## What does not round-trip

The `.sr` format only carries samples, the sample rate and channel names. These Probewire details are not saved in `.sr` files:

| Detail                             | Notes                                                                                  |
| ---------------------------------- | -------------------------------------------------------------------------------------- |
| Trigger position                   | Times show from the start of the capture after reopening.                              |
| Burst boundaries and measured gaps | gusmanb burst captures reopen as one continuous capture.                               |
| Decoder setups                     | Kept in the Probewire library, not in the file. PulseView has its own decoders.        |
| Capture name                       | The file name is used on import, and the capture name becomes the file name on export. |
| Analog units                       | Always volts, as in sigrok.                                                            |

PulseView also saves view settings in a separate `.pvs` file next to the `.sr`. Probewire neither reads nor writes `.pvs` files.

## Other exports

- **Decoder results** export as CSV from the Decoders panel. See [decoders](decoders.md#exporting-results).
