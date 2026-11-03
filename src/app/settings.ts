/** User preferences kept in localStorage. Invalid or missing values fall back to defaults. */
import { getDecoder } from '../decoders/registry';
import type { SerialBackend } from '../drivers/serial/ports';
import { DEFAULT_CONFIGS, DEVICE_CHOICES, type CaptureConfigs, type DeviceChoice } from './connection';
import type { DecoderInstance } from './workspace';

const KEY = 'logic-in-a-tab:settings:v1';

export interface Settings {
  readonly choice: DeviceChoice;
  readonly backend: SerialBackend;
  readonly anyPort: boolean;
  readonly autoSave: boolean;
  readonly configs: CaptureConfigs;
  readonly decoders: readonly DecoderInstance[];
}

export function defaultSettings(likelyMobile: boolean, hasWebSerial: boolean): Settings {
  return {
    choice: 'gusmanb',
    backend: likelyMobile || !hasWebSerial ? 'webusb' : 'web-serial',
    anyPort: false,
    autoSave: true,
    configs: DEFAULT_CONFIGS,
    decoders: [],
  };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function validDecoder(v: unknown): v is DecoderInstance {
  return (
    isObject(v) &&
    typeof v.uid === 'string' &&
    typeof v.decoderId === 'string' &&
    getDecoder(v.decoderId) !== undefined &&
    isObject(v.channels) &&
    isObject(v.options) &&
    Array.isArray(v.hiddenRows)
  );
}

function mergeConfigs(raw: unknown): CaptureConfigs {
  if (!isObject(raw)) return DEFAULT_CONFIGS;
  const pick = <K extends keyof CaptureConfigs>(k: K): CaptureConfigs[K] =>
    isObject(raw[k]) ? ({ ...DEFAULT_CONFIGS[k], ...(raw[k] as object) } as CaptureConfigs[K]) : DEFAULT_CONFIGS[k];
  const gusmanb = pick('gusmanb');
  return {
    gusmanb: Array.isArray(gusmanb.channels) && isObject(gusmanb.trigger) ? gusmanb : DEFAULT_CONFIGS.gusmanb,
    pico: pick('pico'),
    demo: pick('demo'),
  };
}

export function loadSettings(fallback: Settings): Settings {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (!isObject(raw)) return fallback;
    return {
      choice: DEVICE_CHOICES.some((c) => c.id === raw.choice) ? (raw.choice as DeviceChoice) : fallback.choice,
      backend: raw.backend === 'webusb' || raw.backend === 'web-serial' ? raw.backend : fallback.backend,
      anyPort: typeof raw.anyPort === 'boolean' ? raw.anyPort : fallback.anyPort,
      autoSave: typeof raw.autoSave === 'boolean' ? raw.autoSave : fallback.autoSave,
      configs: mergeConfigs(raw.configs),
      decoders: Array.isArray(raw.decoders) ? raw.decoders.filter(validDecoder) : fallback.decoders,
    };
  } catch {
    return fallback;
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Private mode or quota: settings simply will not persist.
  }
}
