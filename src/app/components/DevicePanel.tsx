/** Choose and connect an analyzer, then edit its capture settings. */
import { Fragment } from 'preact';
import type { BackendSupport, SerialBackend } from '../../drivers/serial/ports';
import { DEVICE_CHOICES, type CaptureConfigs, type Connected, type DeviceChoice } from '../connection';
import { DemoForm, GusmanbForm, PicoForm } from './CaptureForms';
import { Field, Segmented } from './fields';

interface DevicePanelProps {
  readonly choice: DeviceChoice;
  readonly onChoice: (c: DeviceChoice) => void;
  readonly backend: SerialBackend;
  readonly onBackend: (b: SerialBackend) => void;
  readonly anyPort: boolean;
  readonly onAnyPort: (v: boolean) => void;
  readonly connected?: Connected;
  readonly connecting: boolean;
  readonly busy: boolean;
  readonly error?: string;
  readonly onConnect: () => void;
  readonly onDisconnect: () => void;
  readonly configs: CaptureConfigs;
  readonly onConfigs: (c: CaptureConfigs) => void;
  readonly support: BackendSupport;
}

export function DevicePanel(props: DevicePanelProps) {
  const { choice, connected, connecting, support } = props;
  const hardware = DEVICE_CHOICES.find((c) => c.id === choice)?.hardware ?? false;
  const noUsb = hardware && !support.webSerial && !support.webUsb;
  return (
    <>
      <div class="group">
        <h2>Analyzer</h2>
        <Field label="Device" htmlFor="dev-choice">
          <select
            id="dev-choice"
            value={choice}
            disabled={!!connected || connecting}
            onChange={(e) => props.onChoice((e.currentTarget as HTMLSelectElement).value as DeviceChoice)}
          >
            <optgroup label="Hardware">
              {DEVICE_CHOICES.filter((c) => c.hardware).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </optgroup>
            <optgroup label="Without hardware">
              {DEVICE_CHOICES.filter((c) => !c.hardware).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </optgroup>
          </select>
        </Field>
        {hardware && !connected && (
          <>
            <Field label="Connect over">
              <Segmented<SerialBackend>
                label="Connection method"
                value={props.backend}
                options={[
                  { value: 'web-serial', label: 'USB serial' },
                  { value: 'webusb', label: 'WebUSB' },
                ]}
                onChange={props.onBackend}
              />
            </Field>
            <p class="hint">
              {props.backend === 'web-serial'
                ? 'Works in Chrome and Edge on computers, and Chrome 148+ on Android 17+.'
                : 'For Android phones without USB serial support: talks to the board over WebUSB. Not for Windows, where the serial driver holds the device.'}
            </p>
            <label class="check">
              <input type="checkbox" checked={props.anyPort} onChange={(e) => props.onAnyPort((e.currentTarget as HTMLInputElement).checked)} />
              Show every serial port, not just matching boards
            </label>
          </>
        )}
        {noUsb && (
          <p class="hint warn">
            This browser cannot reach USB devices. Use Chrome or Edge on a computer, or Chrome on Android. The demo and .sr files still work.
          </p>
        )}
        {hardware && !support.secureContext && <p class="hint warn">USB access needs HTTPS (or localhost).</p>}
        <div class="row" style={{ marginTop: '12px' }}>
          {connected ? (
            <button type="button" class="btn" onClick={props.onDisconnect} disabled={props.busy}>
              Disconnect
            </button>
          ) : (
            <button type="button" class="btn primary" onClick={props.onConnect} disabled={connecting || noUsb}>
              {connecting ? 'Connecting...' : hardware ? 'Choose port and connect' : 'Connect'}
            </button>
          )}
        </div>
        {props.error && (
          <p class="hint error" role="alert">
            {props.error}
          </p>
        )}
      </div>

      {connected && (
        <div class="group">
          <h2>{connected.device.summary.title}</h2>
          <dl class="facts">
            {connected.device.summary.facts.map(([k, v]) => (
              <Fragment key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </Fragment>
            ))}
          </dl>
        </div>
      )}

      {connected?.kind === 'gusmanb' && (
        <GusmanbForm
          info={connected.device.info}
          config={props.configs.gusmanb}
          onChange={(gusmanb) => props.onConfigs({ ...props.configs, gusmanb })}
        />
      )}
      {connected?.kind === 'sigrok-pico' && (
        <PicoForm identity={connected.device.identity} config={props.configs.pico} onChange={(pico) => props.onConfigs({ ...props.configs, pico })} />
      )}
      {connected?.kind === 'demo' && <DemoForm config={props.configs.demo} onChange={(demo) => props.onConfigs({ ...props.configs, demo })} />}

      {!connected && hardware && (
        <div class="group">
          <h2>Firmware</h2>
          <p class="hint" style={{ marginTop: 0 }}>
            {choice === 'gusmanb'
              ? 'Flash the gusmanb/logicanalyzer V6 firmware (UF2) onto a Pico, Pico 2 or Pico W. Up to 24 channels at 100 MHz, 200 MHz in turbo builds.'
              : 'Flash the sigrok-pico UF2 onto a Pico. Up to 21 digital channels (26 or 32 in the dig builds) plus 3 analog.'}
          </p>
        </div>
      )}
    </>
  );
}
