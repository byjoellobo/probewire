# Getting started

This guide walks through Probewire from first launch to a decoded capture. You can follow most of it without any hardware.

## Open the app

Go to **https://byjoellobo.github.io/probewire/** in a recent version of Chrome, Edge or Opera on a computer, or Chrome on Android. Other browsers can open captures and run the demo, but cannot reach USB analyzers. See [browser support](browser-support.md) for the details.

The first screen offers three ways in:

- **Try a demo capture** generates a realistic capture and adds the UART, I2C and SPI decoders, so you can explore straight away.
- **Connect an analyzer** opens the Device panel.
- **Open .sr file** loads a capture saved by PulseView, sigrok-cli or Probewire.

If you have kept captures before, a **Reopen last capture** button appears as well.

## Install it (optional)

Probewire is a progressive web app. Installing it gives it its own window and launcher icon, and it works offline once loaded.

| Platform                     | How to install                                                                                                         |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Chrome or Edge on a computer | Click the install icon at the right end of the address bar, or open the browser menu and choose **Install Probewire**. |
| Chrome on Android            | Open the browser menu and choose **Add to home screen** or **Install app**.                                            |

After installing, `.sr` files can be opened with Probewire from the operating system on browsers that support file handling for web apps.

## Try it without hardware

Open **Device** and pick one of the options under **Without hardware**:

| Option                     | What it does                                                                                                                                                |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Signal generator           | Builds a capture of up to 50 million samples directly: UART text, an I2C EEPROM write and read, a SPI flash ID read, a 1 kHz PWM output and a 10 kHz clock. |
| Simulated gusmanb analyzer | Runs the real gusmanb driver against a model of the V6 firmware over an in-memory serial port. You get the same settings and limits as a Pico 2.            |
| Simulated sigrok-pico      | Runs the real sigrok-pico driver against a model of its firmware, including analog channels.                                                                |

The demo signals need a sample rate of at least about 4 MHz to include all protocol traffic. Below that, some of it is left out and a warning says so.

## Connect real hardware

1. Flash the firmware onto a Raspberry Pi Pico and wire it up. [Hardware](hardware.md) has the details.
2. Plug the Pico into the computer or phone (phones need a USB OTG adapter or a USB-C cable).
3. Open **Device**, choose **gusmanb Logic Analyzer (Pico)** or **sigrok-pico (Pico)**.
4. Choose the connection method:
   - **USB serial** (Web Serial) on computers, and on Chrome 148+ with Android 17+.
   - **WebUSB** on older Android versions.
5. Press **Choose port and connect** and pick the board in the browser's dialog. If your board does not appear, tick **Show every serial port, not just matching boards**.

Once connected, the Device panel shows the analyzer's facts (firmware, channel count, maximum sample rate, buffer size) and its capture settings.

## Capture

Set the channels, trigger and timing in the Device panel, then press **Capture** in the top bar. While a capture runs the button turns into **Stop**, and the status bar shows the phase: configuring, waiting for the trigger, receiving samples, processing.

The settings form checks values against the connected analyzer's limits as you type. The Capture button stays disabled until the settings are valid, and the problem is shown under the form.

New captures are kept in the library automatically. You can turn that off in the Library panel.

## Read the waveform

| Action              | Mouse and keyboard                                  | Touch           |
| ------------------- | --------------------------------------------------- | --------------- |
| Pan                 | Drag the waveform, Shift + wheel, or the arrow keys | Drag sideways   |
| Zoom                | Wheel, or `+` and `-`                               | Pinch           |
| Zoom in at a point  | Double-click (Shift + double-click zooms out)       |                 |
| Show everything     | `F` or `0`, or the fit button                       | The fit button  |
| Place cursor A or B | `A` or `B` (at the centre of the view)              | Tap the ruler   |
| Clear cursors       | `X`, or the clear button                            |                 |
| Scroll rows         | Wheel over the labels                               | Drag up or down |

Keyboard shortcuts work when the waveform area has focus. Click it once, or press Tab to reach it: once a capture is open, the first Tab stop is a "Skip to waveform" link. In the side panel, the arrow keys move between the Device, Decoders and Library tabs, and decoded values in the table open with Enter.

### Cursors

Tap or click the time ruler to place cursor A, then again for cursor B. Drag a cursor's flag to move it. The status bar shows both times, the difference between them and the matching frequency. The clear button in the top bar removes both cursors.

Times are shown relative to the trigger when the capture has one.

### Measure a pulse

Hover over a channel with the mouse, or tap it on a touch screen. The status bar shows the level under the pointer, how long it lasts, and, when the next edges are in the capture, the period, frequency and duty cycle. On an analog row it shows the voltage; on a decoder row it shows the decoded value.

### Rename a channel

Click a channel's name in the left column, type a new name and press Enter. Escape cancels. Names are stored with the capture and exported in `.sr` files.

## Decode protocols

Open **Decoders** and press **UART**, **I²C** or **SPI**. Probewire matches decoder inputs to channels by name, so channels called `TX`, `SDA` or `MOSI` are wired up automatically. Change any input or option in the decoder's block and the result updates.

Each decoder adds rows under the channels. The row buttons in the decoder block show or hide individual rows; bit-level rows start hidden.

**Show values** opens a table of decoded items. Click a row in the table to jump to it in the waveform; the selected item is outlined in gold.

The download button in the decoder block exports everything the decoder found as CSV. See [decoders](decoders.md) for all options and the CSV columns.

Decoder setups stay in place when you take a new capture, so a repeated measurement needs no reconfiguration.

## Save and open files

- **Save**: the download button in the top bar writes the current capture as a sigrok `.sr` file that PulseView 0.4 and sigrok-cli can open.
- **Open**: the folder button, the Library panel, or drag a file onto the window.

See [file format](file-format.md) for what is kept and what is not.

## The library

The Library panel lists captures kept in this browser on this device, newest first, with date, duration, sample rate, sample count and size. From there you can open, rename, export as `.sr`, or delete each one.

The Storage section shows how much space the site uses. Browsers may clear site data when a device runs low on space; **Ask to keep the library** requests persistent storage, which browsers are more likely to grant to installed apps.

## Offline use

After the first visit the app is cached by a service worker. It loads and works without a network connection, including captures, decoding and the library. When a new version is published, a message offers to reload into it.

## Next steps

- [Hardware](hardware.md) for wiring and limits.
- [Decoders](decoders.md) for decoder options.
- [Contributing](../CONTRIBUTING.md) if you test Probewire with a real board. Hardware reports are especially welcome.
