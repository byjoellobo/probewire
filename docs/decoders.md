# Protocol decoders

Probewire includes decoders for UART, I2C and SPI. They are written in TypeScript for Probewire and run in the browser; they are not ports of sigrok's Python decoders.

## Using decoders

1. Open **Decoders** and press **UART**, **I²C** or **SPI**. You can add the same decoder more than once, for example one UART per serial link.
2. Check the channel inputs. Probewire assigns them automatically (see below); change any of them with the dropdowns.
3. Adjust the options. The result updates as soon as an option changes.

Each decoder draws one or more rows under the channels, in the decoder's accent colour. The row buttons in the decoder block show or hide rows; rows ending in "bits" start hidden.

**Show values** lists the decoded items (bits and summaries left out). Click an item to jump to it; it is outlined in gold. The table shows the first 1,000 items; export CSV for all of them.

Decoder setups are kept when you take a new capture and are saved with captures in the library.

### Automatic channel matching

When you add a decoder, Probewire looks at channel names, split into words, and matches them against these hints, most specific first:

| Input    | Names that match                        |
| -------- | --------------------------------------- |
| UART RX  | `rx`, `rxd`, `uart_rx`                  |
| UART TX  | `tx`, `txd`, `uart_tx`                  |
| I2C SCL  | `scl`                                   |
| I2C SDA  | `sda`                                   |
| SPI CLK  | `sck`, `sclk`, `spiclk`, `clk`, `clock` |
| SPI MOSI | `mosi`, `copi`, `sdo`, `dout`           |
| SPI MISO | `miso`, `cipo`, `sdi`, `din`            |
| SPI CS   | `cs`, `ss`, `nss`, `ncs`, `csn`, `cs0`  |

So a channel named `UART TX` or `SPI MOSI` is picked up. If no name matches anything, inputs are assigned to the first channels in order. Required inputs are always filled when channels are available.

### Display format

Every decoder has a **Display as** option: **Hex** (default), **Decimal**, **Binary** or **ASCII**. ASCII shows printable characters in quotes, common control characters by name (`\n`, `\r`, `\t`, `NUL`, `ESC`, `DEL` and so on), and falls back to hex for the rest.

Annotation labels have long and short forms. The waveform shows the longest form that fits, so zooming in reveals more detail.

## UART

Asynchronous serial: a start bit, 5 to 9 data bits, optional parity, then stop bits.

| Input | Required        | Meaning                                   |
| ----- | --------------- | ----------------------------------------- |
| RX    | one of RX or TX | Data received by the device under test    |
| TX    | one of RX or TX | Data transmitted by the device under test |

| Option     | Values                                             | Default   |
| ---------- | -------------------------------------------------- | --------- |
| Baud rate  | any positive number                                | 115200    |
| Data bits  | 5, 6, 7, 8, 9                                      | 8         |
| Parity     | None, Odd, Even, Always 0 (space), Always 1 (mark) | None      |
| Stop bits  | 1, 1.5, 2                                          | 1         |
| Bit order  | LSB first, MSB first                               | LSB first |
| Inverted   | No, Yes                                            | No        |
| Display as | Hex, Decimal, Binary, ASCII                        | Hex       |

Rows: **RX**, **RX bits**, **TX**, **TX bits**.

| Annotation                                 | Row                | Meaning                                                                                                                  |
| ------------------------------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Data value                                 | RX or TX           | One received character, spanning its data bits                                                                           |
| Parity error                               | RX or TX           | The parity bit did not match the chosen parity                                                                           |
| Frame error                                | RX or TX           | The stop bit was not at the idle level. The decoder waits for the line to go idle before looking for the next start bit. |
| Break                                      | RX or TX           | The line stayed at the start level for longer than a whole frame                                                         |
| Start bit, data bits, Parity bit, Stop bit | RX bits or TX bits | The individual bits of each frame                                                                                        |

Each bit is sampled at its centre, timed from the start bit's falling edge (rising edge when inverted).

Tips:

- Sample at **at least 4 times the baud rate**; 8 to 10 times is better. Below 4x the decoder warns that results may be unreliable, and below 2 samples per bit it refuses to decode.
- If every character is a frame error, the baud rate is probably wrong.
- RS-232 levels are inverted relative to TTL UART; use **Inverted: Yes** after a suitable level shifter.

## I2C

Two-wire bus: START, a 7- or 10-bit address with a read/write bit, data bytes each followed by ACK or NACK, then STOP.

| Input | Required | Meaning      |
| ----- | -------- | ------------ |
| SCL   | yes      | Serial clock |
| SDA   | yes      | Serial data  |

| Option         | Values                                    | Default |
| -------------- | ----------------------------------------- | ------- |
| Address format | 7-bit (without R/W), 8-bit (with R/W bit) | 7-bit   |
| Display as     | Hex, Decimal, Binary, ASCII               | Hex     |

Rows: **Bits**, **Frames**, **Transactions**.

| Annotation                          | Row          | Meaning                                                                                                                              |
| ----------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| 0 or 1                              | Bits         | Each bit, sampled on the rising edge of SCL                                                                                          |
| Start, Repeated start               | Frames       | SDA fell while SCL was high                                                                                                          |
| Stop                                | Frames       | SDA rose while SCL was high                                                                                                          |
| Address read / Address write        | Frames       | The address byte. With 10-bit addressing the first byte shows the high address bits and the second the full address.                 |
| Data read / Data write              | Frames       | A data byte and its direction                                                                                                        |
| ACK, NACK                           | Frames       | The ninth bit after each byte                                                                                                        |
| Read 0x50: 42 00, Write 0x50: 00 10 | Transactions | A summary from each START or repeated START to the next, with the address and all data bytes. "address NACK" means nothing answered. |

If SCL and SDA change in the same sample, the decoder treats it as a clock edge. Sample at least 4 times faster than the bus clock (for example 2 MHz or more for 400 kHz I2C).

A register read usually shows as two transactions: a write that sets the register address, then a read after the repeated start.

## SPI

Synchronous serial: a clock, one or two data lines, and an optional chip select.

| Input | Required            | Meaning                       |
| ----- | ------------------- | ----------------------------- |
| CLK   | yes                 | Serial clock                  |
| MOSI  | one of MOSI or MISO | Controller out, peripheral in |
| MISO  | one of MOSI or MISO | Controller in, peripheral out |
| CS    | no                  | Chip select                   |

| Option            | Values                                                     | Default    |
| ----------------- | ---------------------------------------------------------- | ---------- |
| Mode (CPOL, CPHA) | Mode 0 (0, 0), Mode 1 (0, 1), Mode 2 (1, 0), Mode 3 (1, 1) | Mode 0     |
| CS polarity       | Active low, Active high                                    | Active low |
| Bit order         | MSB first, LSB first                                       | MSB first  |
| Word size         | 4 to 32 bits                                               | 8          |
| Display as        | Hex, Decimal, Binary, ASCII                                | Hex        |

Rows: **MOSI**, **MISO**, **Transfers**.

| Annotation                             | Row          | Meaning                                                  |
| -------------------------------------- | ------------ | -------------------------------------------------------- |
| Word value                             | MOSI or MISO | One word, spanning its clock edges                       |
| Partial word (n bits)                  | MOSI or MISO | Chip select was released before a whole word was clocked |
| MOSI: 9F 00 00 00 \| MISO: FF EF 40 18 | Transfers    | Everything exchanged while chip select was active        |

Data is sampled on the rising clock edge in modes 0 and 3 and on the falling edge in modes 1 and 2. Without a CS input, words are counted continuously from the first sampling edge, so a capture that starts mid-word will be misaligned; connect CS when you can.

## Exporting results

The download button in each decoder block saves a CSV file with one line per annotation:

| Column         | Meaning                                                                             |
| -------------- | ----------------------------------------------------------------------------------- |
| `start_s`      | Start time in seconds from the first sample                                         |
| `end_s`        | End time in seconds                                                                 |
| `start_sample` | First sample covered                                                                |
| `end_sample`   | Sample after the last one covered                                                   |
| `row`          | Row label, for example `TX` or `Frames`                                             |
| `kind`         | `data`, `address`, `control`, `ack`, `nack`, `bit`, `summary`, `warning` or `error` |
| `value`        | Numeric value (byte, word or address) where there is one                            |
| `text`         | The longest label, as shown in the waveform                                         |

Times in the CSV count from the start of the capture, not from the trigger.
