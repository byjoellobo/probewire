/** Capture settings for each analyzer type. Each form edits an immutable config. */
import { formatCount, formatDuration } from '../../core/units';
import { DEMO_MAX_SAMPLES, type DemoCaptureConfig } from '../../drivers/demo/demoDevice';
import {
  EXTERNAL_TRIGGER_CHANNEL,
  captureModeFor,
  channelLabel,
  limitsFor,
  validateConfig,
  type GusmanbCaptureConfig,
  type GusmanbDeviceInfo,
  type GusmanbTrigger,
} from '../../drivers/gusmanb/protocol';
import {
  MAX_SAMPLE_RATE,
  MIN_SAMPLE_RATE,
  analogChannelName,
  digitalChannelName,
  effectiveSampleRate,
  validatePicoConfig,
  type PicoCaptureConfig,
  type PicoIdentity,
} from '../../drivers/sigrokPico/protocol';
import { formatHz } from '../../drivers/types';
import { channelSwatch } from '../../render/theme';
import { Errors, Field, NumberInput, RateInput, Segmented } from './fields';

// ---------------------------------------------------------------- gusmanb

type TriggerKind = GusmanbTrigger['type'];

function triggerFor(kind: TriggerKind, prev: GusmanbTrigger): GusmanbTrigger {
  const channel = 'channel' in prev ? prev.channel : 0;
  const falling = 'falling' in prev ? prev.falling : true;
  switch (kind) {
    case 'edge':
      return { type: 'edge', channel, falling, bursts: 0, measureBursts: false };
    case 'blast':
      return { type: 'blast', channel, falling };
    case 'complex':
    case 'fast':
      return { type: kind, baseChannel: 0, bitCount: 2, pattern: 0b01 };
  }
}

function patternText(t: Extract<GusmanbTrigger, { baseChannel: number }>): string {
  return Array.from({ length: t.bitCount }, (_, i) => ((t.pattern >> i) & 1 ? '1' : '0')).join('');
}

interface GusmanbFormProps {
  readonly info: GusmanbDeviceInfo;
  readonly config: GusmanbCaptureConfig;
  readonly onChange: (c: GusmanbCaptureConfig) => void;
}

export function GusmanbForm({ info, config, onChange }: GusmanbFormProps) {
  const errors = validateConfig(config, info);
  const t = config.trigger;
  const mode = config.channels.length > 0 ? captureModeFor(config.channels) : 0;
  const limits = limitsFor(info, mode);
  const set = (patch: Partial<GusmanbCaptureConfig>): void => onChange({ ...config, ...patch });
  const setTrigger = (trigger: GusmanbTrigger): void => {
    const blast = trigger.type === 'blast';
    onChange({
      ...config,
      trigger,
      sampleRate: blast ? info.blastFrequency : Math.min(config.sampleRate, info.maxFrequency),
      preSamples: blast ? 0 : Math.max(config.preSamples, 2),
    });
  };
  const toggle = (ch: number): void => {
    const has = config.channels.includes(ch);
    const channels = has ? config.channels.filter((c) => c !== ch) : [...config.channels, ch].sort((a, b) => a - b);
    set({ channels });
  };
  const all = Array.from({ length: info.channelCount }, (_, i) => i);
  const bursts = t.type === 'edge' ? t.bursts + 1 : 1;
  const totalSamples = (t.type === 'blast' ? 0 : config.preSamples) + config.postSamples * bursts;

  return (
    <>
      <div class="group">
        <h2>
          Channels <small>{config.channels.length} selected</small>
        </h2>
        <div class="chips">
          {all.map((ch) => (
            <button
              key={ch}
              type="button"
              class="chip"
              aria-pressed={config.channels.includes(ch)}
              style={{ '--wire': channelSwatch(ch) } as Record<string, string>}
              onClick={() => toggle(ch)}
            >
              {ch + 1}
            </button>
          ))}
        </div>
        <div class="row" style={{ marginTop: '8px' }}>
          <button type="button" class="btn small" onClick={() => set({ channels: all.slice(0, 8) })}>
            1 to 8
          </button>
          <button type="button" class="btn small" onClick={() => set({ channels: all.slice(0, 16) })}>
            1 to 16
          </button>
          <button type="button" class="btn small" onClick={() => set({ channels: all })}>
            All
          </button>
        </div>
        <p class="hint">Channels above 8 or 16 use more memory per sample: up to {formatCount(limits.totalSamples)} samples with this selection.</p>
      </div>

      <div class="group">
        <h2>Trigger</h2>
        <Segmented<TriggerKind>
          label="Trigger type"
          value={t.type}
          options={[
            { value: 'edge', label: 'Edge' },
            { value: 'complex', label: 'Pattern' },
            { value: 'fast', label: 'Fast' },
            { value: 'blast', label: 'Blast' },
          ]}
          onChange={(k) => setTrigger(triggerFor(k, t))}
        />
        {(t.type === 'edge' || t.type === 'blast') && (
          <>
            <Field label="Channel" htmlFor="g-trig-ch">
              <select
                id="g-trig-ch"
                value={t.channel}
                onChange={(e) => setTrigger({ ...t, channel: Number((e.currentTarget as HTMLSelectElement).value) })}
              >
                {[...all, EXTERNAL_TRIGGER_CHANNEL].map((ch) => (
                  <option key={ch} value={ch}>
                    {ch === EXTERNAL_TRIGGER_CHANNEL ? 'External input (GPIO1)' : channelLabel(ch)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Edge">
              <Segmented
                label="Edge"
                value={t.falling ? 'falling' : 'rising'}
                options={[
                  { value: 'rising', label: 'Rising' },
                  { value: 'falling', label: 'Falling' },
                ]}
                onChange={(v) => setTrigger({ ...t, falling: v === 'falling' })}
              />
            </Field>
          </>
        )}
        {t.type === 'edge' && (
          <>
            <Field label="Extra bursts" htmlFor="g-bursts">
              <NumberInput
                id="g-bursts"
                value={t.bursts}
                min={0}
                max={t.measureBursts ? 253 : 254}
                onChange={(n) => setTrigger({ ...t, bursts: n })}
              />
            </Field>
            <label class="check">
              <input
                type="checkbox"
                checked={t.measureBursts}
                disabled={t.bursts === 0}
                onChange={(e) => setTrigger({ ...t, measureBursts: (e.currentTarget as HTMLInputElement).checked })}
              />
              Measure the gaps between bursts
            </label>
          </>
        )}
        {(t.type === 'complex' || t.type === 'fast') && (
          <>
            <Field label="First channel" htmlFor="g-pat-base">
              <select
                id="g-pat-base"
                value={t.baseChannel}
                onChange={(e) => setTrigger({ ...t, baseChannel: Number((e.currentTarget as HTMLSelectElement).value) })}
              >
                {all.slice(0, t.type === 'fast' ? 5 : 16).map((ch) => (
                  <option key={ch} value={ch}>
                    {channelLabel(ch)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Pattern" htmlFor="g-pat">
              <input
                id="g-pat"
                class="input"
                value={patternText(t)}
                maxLength={t.type === 'fast' ? 5 : 16}
                pattern="[01]+"
                onChange={(e) => {
                  const bits = (e.currentTarget as HTMLInputElement).value.replace(/[^01]/g, '');
                  if (bits.length === 0) return;
                  const pattern = [...bits].reduce((acc, b, i) => acc | ((b === '1' ? 1 : 0) << i), 0);
                  setTrigger({ ...t, bitCount: bits.length, pattern });
                }}
              />
            </Field>
            <p class="hint">Leftmost digit is {channelLabel(t.baseChannel)}. Pattern triggers need GPIO0 bridged to GPIO1 on the board.</p>
          </>
        )}
        {t.type === 'blast' && <p class="hint">Blast mode samples at {formatHz(info.blastFrequency)} with no pre-trigger data.</p>}
      </div>

      <div class="group">
        <h2>Timing</h2>
        <Field label="Sample rate" htmlFor="g-rate">
          {t.type === 'blast' ? (
            <input id="g-rate" class="input" value={formatHz(info.blastFrequency)} disabled />
          ) : (
            <RateInput
              id="g-rate"
              value={config.sampleRate}
              min={limits.minFrequency}
              max={info.maxFrequency}
              onChange={(sampleRate) => set({ sampleRate })}
            />
          )}
        </Field>
        {t.type !== 'blast' && (
          <Field label="Before trigger" htmlFor="g-pre">
            <NumberInput id="g-pre" value={config.preSamples} min={2} max={limits.maxPre} onChange={(preSamples) => set({ preSamples })} />
          </Field>
        )}
        <Field label={t.type === 'edge' && t.bursts > 0 ? 'After, per burst' : 'After trigger'} htmlFor="g-post">
          <NumberInput id="g-post" value={config.postSamples} min={2} max={limits.maxPost} onChange={(postSamples) => set({ postSamples })} />
        </Field>
        <p class="hint">
          {formatCount(totalSamples)} of {formatCount(limits.totalSamples)} samples, {formatDuration(totalSamples / config.sampleRate, 3)} of signal.
        </p>
        <Errors errors={errors} />
      </div>
    </>
  );
}

// ------------------------------------------------------------ sigrok-pico

interface PicoFormProps {
  readonly identity: PicoIdentity;
  readonly config: PicoCaptureConfig;
  readonly onChange: (c: PicoCaptureConfig) => void;
}

export function PicoForm({ identity, config, onChange }: PicoFormProps) {
  const errors = validatePicoConfig(config, identity);
  const set = (patch: Partial<PicoCaptureConfig>): void => onChange({ ...config, ...patch });
  const effective = effectiveSampleRate(config);
  const digital = Array.from({ length: identity.digitalCount }, (_, i) => i);
  const analog = Array.from({ length: identity.analogCount }, (_, i) => i);
  return (
    <>
      <div class="group">
        <h2>
          Digital channels <small>{config.digitalChannels === 0 ? 'none' : `first ${config.digitalChannels}`}</small>
        </h2>
        <div class="chips">
          {digital.map((i) => (
            <button
              key={i}
              type="button"
              class="chip"
              aria-pressed={i < config.digitalChannels}
              style={{ '--wire': channelSwatch(i) } as Record<string, string>}
              title={digitalChannelName(i, identity.digitalCount)}
              onClick={() => set({ digitalChannels: i + 1 === config.digitalChannels ? i : i + 1 })}
            >
              {digitalChannelName(i, identity.digitalCount).replace('GP', '')}
            </button>
          ))}
        </div>
        <p class="hint">sigrok-pico captures a contiguous block of pins from the first one. Labels are GPIO numbers.</p>
      </div>
      {analog.length > 0 && (
        <div class="group">
          <h2>Analog channels</h2>
          <div class="row">
            {analog.map((a) => (
              <button
                key={a}
                type="button"
                class="chip"
                style={{ minWidth: '72px' }}
                aria-pressed={config.analogChannels.includes(a)}
                onClick={() =>
                  set({
                    analogChannels: config.analogChannels.includes(a)
                      ? config.analogChannels.filter((x) => x !== a)
                      : [...config.analogChannels, a].sort((x, y) => x - y),
                  })
                }
              >
                {analogChannelName(a)}
              </button>
            ))}
          </div>
          <p class="hint">Analog limits the rate: about 495 kHz divided by the number of analog channels.</p>
        </div>
      )}
      <div class="group">
        <h2>Timing</h2>
        <Field label="Sample rate" htmlFor="p-rate">
          <RateInput
            id="p-rate"
            value={config.sampleRate}
            min={MIN_SAMPLE_RATE}
            max={MAX_SAMPLE_RATE}
            onChange={(sampleRate) => set({ sampleRate })}
          />
        </Field>
        {effective !== config.sampleRate && <p class="hint">The device will use {formatHz(effective)}.</p>}
        <Field label="Samples" htmlFor="p-count">
          <NumberInput id="p-count" value={config.sampleCount} min={16} max={200_000_000} onChange={(sampleCount) => set({ sampleCount })} />
        </Field>
        <p class="hint">
          {formatDuration(config.sampleCount / effective, 3)} of signal. Captures larger than the Pico's RAM stream over USB; at high rates the device
          may stop with an overflow.
        </p>
        <Errors errors={errors} />
      </div>
    </>
  );
}

// ------------------------------------------------------------------ demo

interface DemoFormProps {
  readonly config: DemoCaptureConfig;
  readonly onChange: (c: DemoCaptureConfig) => void;
}

const DEMO_COUNTS = [1_000_000, 5_000_000, 10_000_000, 20_000_000, DEMO_MAX_SAMPLES];

export function DemoForm({ config, onChange }: DemoFormProps) {
  return (
    <div class="group">
      <h2>Generated signals</h2>
      <p class="hint" style={{ marginTop: 0 }}>
        A microcontroller printing over UART, writing and reading an I2C EEPROM, reading a SPI flash ID, plus PWM and a clock.
      </p>
      <Field label="Sample rate" htmlFor="d-rate">
        <RateInput
          id="d-rate"
          value={config.sampleRate}
          min={10_000}
          max={500_000_000}
          onChange={(sampleRate) => onChange({ ...config, sampleRate })}
        />
      </Field>
      <Field label="Samples" htmlFor="d-count">
        <select
          id="d-count"
          value={config.sampleCount}
          onChange={(e) => onChange({ ...config, sampleCount: Number((e.currentTarget as HTMLSelectElement).value) })}
        >
          {DEMO_COUNTS.map((n) => (
            <option key={n} value={n}>
              {formatCount(n)} ({formatDuration(n / config.sampleRate, 3)})
            </option>
          ))}
        </select>
      </Field>
    </div>
  );
}

/** True when the config for the connected device is ready to capture. */
export function configErrors(
  kind: 'gusmanb' | 'sigrok-pico' | 'demo',
  ctx: { info?: GusmanbDeviceInfo; identity?: PicoIdentity },
  configs: {
    gusmanb: GusmanbCaptureConfig;
    pico: PicoCaptureConfig;
  },
): string[] {
  if (kind === 'gusmanb' && ctx.info) return validateConfig(configs.gusmanb, ctx.info);
  if (kind === 'sigrok-pico' && ctx.identity) return validatePicoConfig(configs.pico, ctx.identity);
  return [];
}
