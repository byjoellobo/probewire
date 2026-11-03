/** Small form controls shared by the panels. */
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { formatFrequency } from '../../core/units';
import { parseSizeString } from '../../formats/sizestring';

export function Field({ label, children, htmlFor }: { label: string; children: ComponentChildren; htmlFor?: string }) {
  return (
    <label class="field" for={htmlFor}>
      <span>{label}</span>
      {children}
    </label>
  );
}

interface SegmentedProps<T extends string> {
  readonly label: string;
  readonly value: T;
  readonly options: ReadonlyArray<{ readonly value: T; readonly label: string }>;
  readonly onChange: (v: T) => void;
}

export function Segmented<T extends string>({ label, value, options, onChange }: SegmentedProps<T>) {
  return (
    <div class="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

const RATE_PRESETS = [10e3, 50e3, 100e3, 250e3, 500e3, 1e6, 2e6, 4e6, 5e6, 10e6, 20e6, 25e6, 50e6, 100e6, 200e6];

interface RateInputProps {
  readonly id: string;
  readonly value: number;
  readonly max: number;
  readonly min?: number;
  readonly onChange: (hz: number) => void;
}

/** Sample-rate entry: pick a preset or type "12.5M", "800k", "48000". */
export function RateInput({ id, value, max, min = 0, onChange }: RateInputProps) {
  const [text, setText] = useState(formatFrequency(value, 6));
  const [bad, setBad] = useState(false);
  useEffect(() => {
    setText(formatFrequency(value, 6));
    setBad(false);
  }, [value]);
  const commit = (raw: string): void => {
    const hz = parseSizeString(raw);
    if (!Number.isFinite(hz) || hz <= 0) {
      setBad(true);
      return;
    }
    setBad(false);
    onChange(hz);
  };
  const listId = `${id}-presets`;
  const errorId = `${id}-error`;
  return (
    <div class="stack">
      <input
        id={id}
        class="input"
        list={listId}
        value={text}
        inputMode="decimal"
        aria-invalid={bad}
        aria-describedby={bad ? errorId : undefined}
        onInput={(e) => setText((e.currentTarget as HTMLInputElement).value)}
        onChange={(e) => commit((e.currentTarget as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit((e.currentTarget as HTMLInputElement).value);
        }}
      />
      {bad && (
        <span id={errorId} class="hint error">
          Enter a rate such as 10M, 500k or 48000.
        </span>
      )}
      <datalist id={listId}>
        {RATE_PRESETS.filter((r) => r <= max && r >= min).map((r) => (
          <option key={r} value={formatFrequency(r, 6)} />
        ))}
      </datalist>
    </div>
  );
}

interface NumberInputProps {
  readonly id: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step?: number;
  readonly onChange: (n: number) => void;
}

/** Integer input that only reports valid numbers (clamped on commit). */
export function NumberInput({ id, value, min, max, step = 1, onChange }: NumberInputProps) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = (raw: string): void => {
    const n = Number(raw.replace(/[,_\s]/g, ''));
    if (!Number.isFinite(n)) {
      setText(String(value));
      return;
    }
    const clamped = Math.min(max, Math.max(min, Math.round(n)));
    setText(String(clamped));
    onChange(clamped);
  };
  return (
    <input
      id={id}
      class="input"
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      step={step}
      value={text}
      onInput={(e) => setText((e.currentTarget as HTMLInputElement).value)}
      onChange={(e) => commit((e.currentTarget as HTMLInputElement).value)}
    />
  );
}

export function Errors({ errors }: { errors: readonly string[] }) {
  if (errors.length === 0) return null;
  return (
    <div role="alert">
      {errors.map((e) => (
        <p key={e} class="hint error">
          {e}
        </p>
      ))}
    </div>
  );
}
