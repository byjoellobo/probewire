# Device protocols

This page documents the two USB protocols exactly as Probewire speaks them. It is useful for debugging, for writing new drivers, and for checking Probewire's behaviour against the firmware.

Both drivers were implemented from descriptions of the protocols, gathered by reading the firmware and host sources of the upstream projects. No code from those GPL-3.0 projects was copied or translated. The upstream projects are the authority:

- gusmanb: https://github.com/gusmanb/logicanalyzer (firmware `Firmware/LogicAnalyzer_V2`, host driver `Software/LogicAnalyzer/SharedDriver`)
- sigrok-pico: https://github.com/pico-coder/sigrok-pico, with the libsigrok `raspberrypi-pico` driver as the reference host

Both firmwares present a USB CDC-ACM serial port. The baud rate setting has no effect on USB CDC; Probewire opens at 115200. **Never open these ports at 1200 baud**: the Pico SDK treats that as a request to reboot into the bootloader.

## gusmanb Logic Analyzer (firmware V6)

| Item            | Value                                                                               |
| --------------- | ----------------------------------------------------------------------------------- |
| USB ID          | `1209:3020`, manufacturer "Dr. Gusman", product "LogicAnalyzer"                     |
| Control signals | DTR must be asserted, or the firmware sends nothing. Probewire asserts DTR and RTS. |
| Host to device  | Binary frames                                                                       |
| Device to host  | ASCII lines ending in `\r\n`, then raw binary capture data                          |

### Framing

```
55 AA  <escaped payload>  AA 55
payload = [command byte][command body]
```

Inside the payload, the bytes `AA`, `55` and `F0` are sent as `F0` followed by the byte XOR `F0`:

| Byte | Sent as |
| ---- | ------- |
| `AA` | `F0 5A` |
| `55` | `F0 A5` |
| `F0` | `F0 00` |

There is no length field or checksum. The firmware's receive buffer is 128 bytes, so Probewire refuses to build longer frames.

### Commands

| Code | Command              | Body                    | Reply                                           |
| ---- | -------------------- | ----------------------- | ----------------------------------------------- |
| 0    | Device info          | none                    | five lines, below                               |
| 1    | Start capture        | 48-byte capture request | `CAPTURE_STARTED` or `CAPTURE_ERROR`            |
| 4    | Reboot to bootloader | none                    | `RESTARTING_BOOTLOADER` (not used by Probewire) |
| 5    | Blink LED on         | none                    | `BLINKON`                                       |
| 6    | Blink LED off        | none                    | `BLINKOFF`                                      |

Codes 2 (WiFi settings) and 3 (power status) exist for the WiFi build and are not used. Unknown commands get `ERR_UNKNOWN_MSG`.

### Handshake

The reply to command 0 is five lines, in order:

```
LOGIC_ANALYZER_PICO_2_V6_0
FREQ:100000000
BLASTFREQ:200000000
BUFFER:393216
CHANNELS:24
```

- The first line is `LOGIC_ANALYZER_<board>_V<major>_<minor>`, where board is `PICO`, `PICO_2`, `W`, `WIFI` or `ZERO`.
- `FREQ` is the maximum sample rate, `BLASTFREQ` the blast-mode rate, `BUFFER` the capture buffer in bytes and `CHANNELS` the channel count.
- Probewire requires major version 6 or later.
- Turbo builds use the same board names, so Probewire detects them by `FREQ` of 200 MHz or more.

Before sending command 0, Probewire discards any stale input. It skips lines until the banner appears, and waits up to 10 seconds in total, because the firmware pauses about two seconds after USB enumeration.

### Capture request

48 bytes, little-endian, natural C alignment (the struct is not packed):

| Offset | Type    | Field           | Meaning                                                                                          |
| ------ | ------- | --------------- | ------------------------------------------------------------------------------------------------ |
| 0      | u8      | triggerType     | 0 edge, 1 pattern, 2 fast pattern, 3 blast                                                       |
| 1      | u8      | trigger         | Edge or blast: channel 0 to 23, or 24 for the external input (GPIO1). Pattern: first channel.    |
| 2      | u8      | invertedOrCount | Edge or blast: 0 triggers on high (rising), 1 on low (falling). Pattern: number of pattern bits. |
| 3      |         | padding         |                                                                                                  |
| 4      | u16     | triggerValue    | Pattern: bit _i_ is the level wanted on channel (trigger + _i_). Otherwise 0.                    |
| 6      | u8 x 24 | channels        | Channel numbers to capture, in order; unused entries 0                                           |
| 30     | u8      | channelCount    | Number of entries used in `channels`                                                             |
| 31     |         | padding         |                                                                                                  |
| 32     | u32     | frequency       | Sample rate in Hz                                                                                |
| 36     | u32     | preSamples      | Samples before the trigger                                                                       |
| 40     | u32     | postSamples     | Samples after the trigger, per burst                                                             |
| 44     | u8      | loopCount       | Extra bursts (edge only); total bursts = loopCount + 1                                           |
| 45     | u8      | measure         | 1 to record burst timestamps (edge with loopCount > 0 only)                                      |
| 46     | u8      | captureMode     | 0: 8 channels, 1 byte per sample; 1: 16 channels, 2 bytes; 2: 24 channels, 4 bytes               |
| 47     |         | padding         |                                                                                                  |

How Probewire fills it:

- **Capture mode** comes from the highest channel number selected: below 8 gives mode 0, below 16 gives mode 1, otherwise mode 2.
- **Blast** sends preSamples 0, loopCount 0 and the blast rate.
- **Pattern triggers** are recognised a few cycles late. Probewire asks for extra pre-trigger samples and correspondingly fewer post-trigger samples, so the trigger lands where you expect. The offset is `round(latency x sampleRate / maxRate + 0.3)` samples, with a latency of 3 for fast and 5 for normal pattern triggers.
- **measure** is only sent when there are extra bursts. Measuring with no extra bursts would stall the firmware.

### Capture reply

1. A line: `CAPTURE_STARTED`, or `CAPTURE_ERROR` if the firmware rejects the request. Probewire waits up to 10 seconds.
2. Nothing more until the trigger fires and the capture completes. Probewire waits indefinitely here, until you press Stop.
3. Binary data, with no framing:

| Part                | Format                                                                     |
| ------------------- | -------------------------------------------------------------------------- |
| Sample count _N_    | u32, little-endian                                                         |
| Samples             | _N_ x 1, 2 or 4 bytes (per the capture mode), little-endian, in time order |
| Timestamp count _S_ | u8                                                                         |
| Timestamps          | only if _S_ > 1: _S_ x u32, little-endian                                  |

**Bit _i_ of each sample is the _i_-th channel in the request's channel list**, not channel number _i_. The firmware reorders the bits before sending. Probewire therefore names bit _i_ after `channels[i]`. In 24-channel mode, bits above 23 are masked off.

_N_ is `preSamples + postSamples x (loopCount + 1)`, or `postSamples` in blast mode. Probewire waits up to 30 seconds for the sample data and 5 seconds for the timestamps.

**Burst timestamps.** When measuring, there are `loopCount + 2` timestamps: a reference, then one at the end of each burst. Each is a SysTick snapshot: the low 24 bits count down at the CPU clock (200 MHz, or 400 MHz on turbo builds), and the high 8 bits count rollovers. Probewire converts each to elapsed ticks (`rollovers x 2^24 + (0xFFFFFF - low)`). The gap before burst _k_ is the time between the ends of bursts _k - 1_ and _k_, minus the burst's own duration.

### Cancelling

There is no stop command. While a capture is armed, the firmware checks for incoming bytes about every two seconds, and **any byte cancels the capture**. It sends nothing in reply.

Probewire sends exactly one `0xFF` byte, waits 2.5 seconds, then discards whatever arrives: a capture that finished at the same moment may still be streaming its data. It does this:

- when you press Stop;
- when anything fails after the capture request was sent, except a `CAPTURE_ERROR` reply (the device never armed);
- when the analyzer is disconnected from the app mid-capture.

No other command may be sent while a capture is running, because its first byte would act as a cancel.

## sigrok-pico

| Item            | Value                                                                                                                                         |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| USB ID          | Pico SDK defaults: `2E8A:000A` (RP2040), `2E8A:0009` (RP2350). Shared by many Pico programs, so the device is identified by its reply to `i`. |
| Control signals | Probewire sets DTR on and RTS off. Recent firmware does not need DTR; older builds do.                                                        |
| Host to device  | ASCII commands ending in `\n` (or `\r`), plus two single-character commands                                                                   |
| Device to host  | Short ASCII replies with no line ending, then the sample stream                                                                               |

### Commands

Most commands acknowledge with a single `*`. Invalid commands get no reply, so the host has to time out.

| Command                | Meaning                                            | Reply                                                              |
| ---------------------- | -------------------------------------------------- | ------------------------------------------------------------------ |
| `i`                    | Identify                                           | `SRPICO,A<nn><s>D<nn>,02`                                          |
| `a<n>`                 | Analog scale for channel _n_                       | `<microvolts per step>x<offset microvolts>`, for example `25700x0` |
| `A<e><n>`              | Enable (_e_ = 1) or disable (0) analog channel _n_ | `*`                                                                |
| `D<e><n>`              | Enable or disable digital channel _n_              | `*`                                                                |
| `L<count>`             | Number of samples                                  | `*`                                                                |
| `R<rate>`              | Sample rate in Hz, 5000 to 120000016               | `*`                                                                |
| `F`                    | Start a fixed-length capture                       | none; the stream starts                                            |
| `C`                    | Start a continuous capture                         | none (not used by Probewire)                                       |
| `*` (single character) | Reset sampling state                               | none                                                               |
| `+` (single character) | Stop a running capture                             | the trailer                                                        |

The identify reply `SRPICO,A031D21,02` means 3 analog channels, 1 byte per analog sample, 21 digital channels, protocol version 02. Probewire requires version 02.

Command lines are limited to about 19 characters. The `*` reset does not stop a running capture; `+` does.

### Connecting and configuring

On connect, Probewire sends `\n*` (the newline clears any half-typed command), discards input, sends `i\n` and waits up to 1.2 seconds for the identify reply, trying once more if needed. It then reads each analog channel's scale with `a<n>\n`, falling back to 25.7 mV per step if there is no reply.

For each capture:

1. `\n*`, then discard input.
2. `A<e><n>\n` for every analog channel the firmware has, enabled or not, each waiting up to 1 second for `*`.
3. `D<e><n>\n` for every digital channel. Enabled channels are always the first _N_.
4. `L<count>\n`, where count is the requested sample count rounded up to a multiple of 8 (at least 16). The firmware works in groups of 8 in its compact mode; Probewire trims the extra samples.
5. `R<rate>\n`. The rate is first adjusted the way the device needs: at least 5 kHz, at most 120 MHz, even, and, when analog and digital channels are both enabled, a rate that divides 24 MHz.
6. Discard input, then `F\n`. The stream begins immediately.

### Stream encoding

Every byte in the stream belongs to one of three classes:

| Byte value       | Class                                                                                                |
| ---------------- | ---------------------------------------------------------------------------------------------------- |
| `0x80` to `0xFF` | Data (7 payload bits)                                                                                |
| `0x30` to `0x7F` | Run length: repeat the previous sample                                                               |
| below `0x30`     | Control: `$` starts the end-of-capture trailer; anything else (such as `!`) means the device aborted |

**Compact mode** is used with 1 to 4 digital channels and no analog channels. Each data byte carries one sample and a short repeat count:

- Data byte `1rrrvvvv`: first repeat the previous sample `rrr` more times, then add one sample with value `vvvv` (bit 0 is channel 0).
- Run-length byte _b_ (48 to 127): repeat the previous sample `(b - 47) x 8` more times (8 to 640).

**General mode** is used otherwise. Each sample is a slice of bytes, digital first and then analog:

- Digital: `ceil(N / 7)` bytes, each holding 7 channels in bits 0 to 6, lowest channels first. With 21 channels that is 3 bytes; with 32 channels, 5.
- Analog: one byte per enabled analog channel, in ascending channel order, holding a 7-bit value. The voltage is `value x scale + offset`.
- Run-length bytes may appear between slices, but only when no analog channel is enabled. Byte _b_ from 48 to 79 repeats the previous slice `b - 47` more times (1 to 32); from 80 to 127 it repeats it `(b - 78) x 32` more times (64 to 1568).

The firmware sends bits for every pin in its capture width, including disabled channels inside a 7-bit group, so Probewire masks the result with the enabled channels.

### End of capture

- **Normal end:** `$<count>+` followed by a newline. _count_ is the number of data and run-length bytes sent. Probewire compares it with what arrived and warns "Data loss" if they differ.
- **Abort:** after an overflow (USB could not keep up) or an invalid analog rate, the device sends `!!!`, waits, then sends `$0+`. Probewire reports the abort, and keeps any samples received if there were some.

Probewire checks every byte for the trailer, including the last byte of each USB read. (The libsigrok driver has a bug here: it misreads a `$` that arrives as the final byte of a read.)

Other details:

- If no data arrives for 15 seconds, Probewire stops the capture and reports a stall.
- Once enough samples have arrived, Probewire sends `+` as a safety net, in case the device rounded the count up.
- Stopping sends `+` and then discards input for up to 2.5 seconds.
