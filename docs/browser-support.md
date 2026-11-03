# Browser support

Probewire reaches analyzers through one of two browser APIs. Everything else (the demo, the simulators, decoding, `.sr` files, the library) works in any modern browser.

This page reflects the state of browsers as of **November 2026**. Items marked _reported_ come from vendor documentation and release notes and have not been checked on a device by the Probewire maintainers.

## Summary

| Browser and platform                                                | Connection method       | Status                                                      |
| ------------------------------------------------------------------- | ----------------------- | ----------------------------------------------------------- |
| Chrome, Edge 89+ on Windows, macOS, Linux, ChromeOS                 | USB serial (Web Serial) | Supported                                                   |
| Opera 76+ on desktop                                                | USB serial (Web Serial) | Supported (reported)                                        |
| Firefox 151+ on desktop                                             | USB serial (Web Serial) | Supported (reported). May ask for a site permission add-on. |
| Chrome 148+ on Android 17+                                          | USB serial (Web Serial) | Supported (reported)                                        |
| Chrome 138 to 147 on Android, or any Chrome on Android 16 and older | WebUSB                  | Supported through the WebUSB fallback                       |
| Firefox for Android                                                 | none                    | No USB access                                               |
| Safari on macOS, any browser on iOS or iPadOS                       | none                    | No USB access                                               |
| Android WebView (apps that wrap web pages)                          | none                    | No USB access                                               |

## USB serial (Web Serial API)

This is the default on computers. The Pico firmware presents itself as a USB serial port (CDC-ACM), and the browser opens it directly.

- Desktop Chrome and Edge have supported Web Serial since version 89.
- Firefox added Web Serial on desktop in version 151 (May 2026). Mozilla's documentation mentions a synthetic site permission add-on, similar to Web MIDI, so expect an extra permission step.
- On Android, Chrome 138 added `navigator.serial` for **Bluetooth serial only**. Wired USB serial arrived in **Chrome 148**, and it needs **Android 17** (API level 37), because Chrome uses Android 17's new system serial service. The phone maker must also include the kernel's USB serial driver.

Because Chrome on Android exposes `navigator.serial` from version 138 even when wired USB is unavailable, Probewire cannot tell from the API alone whether USB serial will work. It offers both connection methods and defaults to WebUSB on phones.

## WebUSB fallback

On Android phones without wired Web Serial, Probewire talks to the Pico's CDC-ACM interface directly over WebUSB, using [web-serial-polyfill](https://github.com/google/web-serial-polyfill). The polyfill gives the drivers the same port interface as Web Serial, so the same code runs on both.

Notes:

- WebUSB has been available in Chrome for Android since version 61.
- Android has its own kernel serial driver. Current Chrome versions detach it automatically before claiming the interface; on older versions or some phones, claiming the interface may fail with an access error. Unplugging and replugging the board usually helps.
- Android shows its own **Allow access** dialog after the browser's device picker.
- The phone needs USB OTG support: a USB-C cable or an OTG adapter.
- **Do not use WebUSB mode on Windows.** Windows' serial driver owns the device, so WebUSB cannot claim it. Use USB serial on computers.
- The polyfill does not report disconnects. If the board is unplugged during a capture, Probewire notices when the next read fails.
- The polyfill repository is archived; Probewire uses its last published version (1.0.15).

## Requirements that apply everywhere

- **HTTPS.** Both APIs only work on secure pages. The hosted app is served over HTTPS; local development works on `localhost`.
- **A user gesture.** The browser only shows the port picker in response to a click or tap, so connecting always starts from the **Choose port and connect** button.
- **Previously granted ports.** Once you grant access to a board, the browser remembers it for this site. Revoke access from the browser's site settings.
- **Embedding.** If you embed Probewire in an iframe, the frame needs `allow="serial"` (and `allow="usb"` for WebUSB mode).

## Choosing a method in the app

In **Device**, under **Connect over**:

- **USB serial** for computers and for Android 17+ with Chrome 148+.
- **WebUSB** for other Android phones.

If one method shows an empty picker or fails to open the port, try the other.

## Sources

- Chrome 138 and 148 release notes: https://developer.chrome.com/release-notes/138 and https://developer.chrome.com/release-notes/148
- Chrome Platform Status, Web Serial on Android: https://chromestatus.com/feature/6043992171085824
- MDN Web Serial API and compatibility data: https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API
- Firefox 151 release notes: https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/151
- Web Serial specification: https://serial.spec.whatwg.org/
- WebUSB specification: https://usb.spec.whatwg.org/
- web-serial-polyfill: https://github.com/google/web-serial-polyfill
