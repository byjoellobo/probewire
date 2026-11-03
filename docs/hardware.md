# Hardware

Probewire works with two open-source logic analyzer firmwares for the Raspberry Pi Pico family. Both turn a Pico into a USB serial device; Probewire talks to them from the browser.

|                       | gusmanb Logic Analyzer                                            | sigrok-pico                                                         |
| --------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------- |
| Project               | [gusmanb/logicanalyzer](https://github.com/gusmanb/logicanalyzer) | [pico-coder/sigrok-pico](https://github.com/pico-coder/sigrok-pico) |
| Firmware version      | V6.0 or newer                                                     | protocol version 02                                                 |
| Digital channels      | up to 24                                                          | 21 (26 or 32 in the "dig" builds)                                   |
| Analog channels       | none                                                              | up to 3 (baseline build)                                            |
| Max sample rate       | 100 MHz (200 MHz turbo builds)                                    | 120 MHz                                                             |
| How samples arrive    | stored on the Pico, then sent                                     | streamed over USB while capturing                                   |
| Triggers in Probewire | edge, pattern, fast pattern, blast, bursts                        | none (capture starts immediately)                                   |

> **Status:** Probewire v0.1.0 has been verified against detailed models of both firmwares, not yet on physical boards. If you try it with real hardware, a [hardware report](https://github.com/byjoellobo/probewire/issues/new?template=hardware_report.yml) helps a lot.

## Flashing the firmware

Both projects ship UF2 files. To flash one:

1. Hold the **BOOTSEL** button on the Pico while plugging it into a computer. It appears as a USB drive called `RPI-RP2` (RP2040) or `RP2350` (RP2350).
2. Copy the UF2 file onto the drive. The Pico reboots into the new firmware.

Which file to use:

- **gusmanb:** from the [releases page](https://github.com/gusmanb/logicanalyzer/releases), take the build for your board: Pico, Pico 2, Pico W or Zero. Pico, Pico 2 and Zero also come in a **Turbo** variant that overclocks to reach 200 MHz sampling. Use firmware V6.0 or later; Probewire refuses older versions.
- **sigrok-pico:** from the [releases page](https://github.com/pico-coder/sigrok-pico/releases), take the baseline build (21 digital and 3 analog channels) unless you need more digital channels, in which case use the 26- or 32-channel "dig" builds.

## Wiring

- **Connect a ground wire first.** The Pico's GND must be connected to the ground of the circuit you are measuring, or readings will be meaningless.
- Use short probe wires, especially above a few MHz.
- **Inputs are 3.3 V logic.** Do not apply more than 3.3 V to a GPIO or ADC pin. To measure 5 V signals, use a level shifter or a resistor divider.
- The Pico is powered from USB, so the target circuit does not need to supply it.

### gusmanb pin map (Pico, Pico 2, Pico W)

Channels are numbered from 1 in Probewire, as in the gusmanb desktop app.

| Probewire channel      | GPIO             |
| ---------------------- | ---------------- |
| CH1 to CH21            | GPIO2 to GPIO22  |
| CH22 to CH24           | GPIO26 to GPIO28 |
| External trigger input | GPIO1            |

**Pattern and fast-pattern triggers** route the trigger state machine's output out on GPIO0 and back in on GPIO1, so they need a **jumper wire between GPIO0 and GPIO1**.

The Pico Zero build uses a different pin map. Check the gusmanb documentation for it.

### sigrok-pico pin map

Probewire names sigrok-pico channels by GPIO number, so the label on screen matches the pin.

| Firmware build                  | Digital channel _i_                                                | Analog                       |
| ------------------------------- | ------------------------------------------------------------------ | ---------------------------- |
| Baseline (21 digital, 3 analog) | GP(_i_ + 2): GP2 to GP22                                           | ADC0 to ADC2 on GP26 to GP28 |
| dig26 (26 digital)              | channels 0 to 22 on GP0 to GP22, channels 23 to 25 on GP26 to GP28 | none                         |
| dig32 (32 digital)              | GP*i*                                                              | none                         |

sigrok-pico always captures a contiguous block of channels starting from the first one, so in Probewire you choose how many digital channels to capture rather than which ones.

## Limits

### gusmanb

The capture buffer holds a fixed number of bytes, and wider captures use more bytes per sample. The channel mode is chosen from the **highest channel number** you select, not the count: selecting only CH1 and CH20 still uses 24-channel mode.

| Board              | Buffer  | 8-channel mode (CH1 to CH8) | 16-channel mode (up to CH16) | 24-channel mode |
| ------------------ | ------- | --------------------------- | ---------------------------- | --------------- |
| Pico, Pico W, Zero | 128 KiB | 131,072 samples             | 65,536 samples               | 32,768 samples  |
| Pico 2             | 384 KiB | 393,216 samples             | 196,608 samples              | 98,304 samples  |

Other limits, as enforced by Probewire before sending a request:

| Setting                          | Limit                                                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Sample rate                      | from (max rate x 2 / 65535) up to the max rate: 3,051 Hz to 100 MHz on normal builds, 6,103 Hz to 200 MHz on turbo builds |
| Samples before the trigger       | 2 up to one tenth of the buffer                                                                                           |
| Samples after the trigger        | at least 2; before + after x bursts must fit in the buffer                                                                |
| Extra bursts (edge trigger only) | 0 to 254, or 0 to 253 when measuring the gaps between bursts                                                              |
| Blast mode                       | always at the blast rate (200 MHz, or 400 MHz turbo), no pre-trigger samples, no bursts                                   |
| Pattern trigger                  | 1 to 16 bits within CH1 to CH16                                                                                           |
| Fast pattern trigger             | 1 to 5 bits within CH1 to CH5                                                                                             |

Burst captures re-arm the trigger after each burst and record the samples back to back. With **Measure the gaps between bursts** ticked, Probewire reports the dead time before each extra burst.

### sigrok-pico

| Setting                  | Limit                                                                                                                      |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Sample rate              | 5 kHz to 120 MHz. The firmware docs recommend 60 MHz or less with 8 or more channels.                                      |
| Analog sample rate       | sample rate x number of analog channels must stay below about 495 kHz. For example, 3 analog channels allow up to 164 kHz. |
| Mixed analog and digital | the rate is adjusted to divide 24 MHz exactly; Probewire shows the rate that will be used.                                 |
| Sample count             | 16 to 200,000,000                                                                                                          |

sigrok-pico keeps samples in RAM and streams them to the host as it goes. Captures that fit in RAM never overflow. Longer ones depend on USB keeping up (roughly 300 to 400 KB/s was measured by the firmware author); if it does not, the device aborts the capture.

Approximate in-RAM depth on an RP2040 (roughly double on RP2350):

| Digital channels (no analog) | Samples that fit in RAM |
| ---------------------------- | ----------------------- |
| 1 to 4                       | about 440,000           |
| 5 to 8                       | about 220,000           |
| 9 to 16                      | about 110,000           |
| 17 to 32                     | about 55,000            |

Analog samples are 7-bit values (the top bits of the 12-bit ADC) at about 25.7 mV per step over 0 to 3.3 V, and the three channels are converted in turn, so they are slightly staggered in time.

## Troubleshooting

| Symptom                                               | What to try                                                                                                                                                                             |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The board does not appear in the port picker          | Tick **Show every serial port, not just matching boards** in the Device panel. Check the cable carries data, not just power.                                                            |
| "The port is busy"                                    | Close other programs that have the port open: PulseView, the gusmanb desktop app, Arduino IDE, serial monitors.                                                                         |
| "No answer from the analyzer"                         | Make sure the firmware is running (not in BOOTSEL mode), unplug and replug the board, then connect again. gusmanb waits about two seconds after USB enumeration before it answers.      |
| "Firmware V5_x is too old"                            | Flash gusmanb firmware V6.0 or newer.                                                                                                                                                   |
| A gusmanb capture never finishes                      | It is waiting for the trigger. Check the trigger channel and edge, or press **Stop**. The analyzer checks for a cancel request about every two seconds, so stopping can take that long. |
| "The device aborted the capture" (sigrok-pico)        | USB could not keep up or the analog rate was too high. Lower the sample rate, use fewer channels, or shorten the capture so it fits in RAM.                                             |
| "Data loss" or "Some bytes from the device were lost" | Bytes were dropped on the way. Lower the sample rate or channel count and capture again.                                                                                                |
| On Android, nothing happens after picking the device  | Android shows its own "Allow access" prompt after the browser's picker; accept it. A USB OTG adapter or USB-C cable is needed.                                                          |
| WebUSB mode fails on Windows                          | Windows' serial driver owns the device. Use **USB serial** on computers; WebUSB mode is for Android.                                                                                    |
| "The analyzer was unplugged"                          | The USB connection dropped. Plug it back in and press connect again.                                                                                                                    |

For browser-specific issues, see [browser support](browser-support.md).
