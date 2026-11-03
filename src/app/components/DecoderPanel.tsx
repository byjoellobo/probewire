/** Add protocol decoders, wire them to channels and browse what they decoded. */
import { useMemo, useState } from 'preact/hooks';
import type { Capture } from '../../core/capture';
import { formatDuration } from '../../core/units';
import { DECODERS, getDecoder } from '../../decoders/registry';
import type { Annotation, DecoderDef, DecoderOptionSpec } from '../../decoders/types';
import { ANNOTATION_COLORS } from '../../render/theme';
import { newDecoderInstance, type DecoderInstance, type DecoderResult } from '../workspace';
import { Field, NumberInput } from './fields';
import { IconSave, IconTrash } from './icons';

interface DecoderPanelProps {
  readonly capture?: Capture;
  readonly instances: readonly DecoderInstance[];
  readonly results: Readonly<Record<string, DecoderResult>>;
  readonly onChange: (instances: readonly DecoderInstance[]) => void;
  readonly onJump: (a: Annotation, uid: string) => void;
  readonly onExportCsv: (uid: string) => void;
  readonly accentFor: (uid: string) => string;
}

export function DecoderPanel({ capture, instances, results, onChange, onJump, onExportCsv, accentFor }: DecoderPanelProps) {
  const update = (uid: string, patch: Partial<DecoderInstance>): void =>
    onChange(instances.map((i) => (i.uid === uid ? { ...i, ...patch } : i)));
  return (
    <>
      <div class="group">
        <h2>Add a decoder</h2>
        <div class="row">
          {DECODERS.map((d) => (
            <button key={d.id} type="button" class="btn" title={d.description} onClick={() => onChange([...instances, newDecoderInstance(d.id, capture)])}>
              {d.name}
            </button>
          ))}
        </div>
        {instances.length === 0 && (
          <p class="hint">Decoders turn waveforms into bytes. Channels are matched by name (TX, SDA, MOSI...) and you can change them below.</p>
        )}
      </div>
      {instances.map((inst) => {
        const def = getDecoder(inst.decoderId);
        if (!def) return null;
        return (
          <DecoderBlock
            key={inst.uid}
            def={def}
            inst={inst}
            capture={capture}
            result={results[inst.uid]}
            accent={accentFor(inst.uid)}
            onUpdate={(patch) => update(inst.uid, patch)}
            onRemove={() => onChange(instances.filter((i) => i.uid !== inst.uid))}
            onJump={(a) => onJump(a, inst.uid)}
            onExport={() => onExportCsv(inst.uid)}
          />
        );
      })}
    </>
  );
}

interface DecoderBlockProps {
  readonly def: DecoderDef;
  readonly inst: DecoderInstance;
  readonly capture?: Capture;
  readonly result?: DecoderResult;
  readonly accent: string;
  readonly onUpdate: (patch: Partial<DecoderInstance>) => void;
  readonly onRemove: () => void;
  readonly onJump: (a: Annotation) => void;
  readonly onExport: () => void;
}

const TABLE_LIMIT = 1000;

function DecoderBlock({ def, inst, capture, result, accent, onUpdate, onRemove, onJump, onExport }: DecoderBlockProps) {
  const [showTable, setShowTable] = useState(false);
  const values = useMemo(() => {
    if (!result?.ok) return [];
    return result.output.annotations.filter((a) => a.kind !== 'bit' && a.kind !== 'summary');
  }, [result]);
  const meta = !capture
    ? 'Waiting for a capture'
    : !result
      ? 'Decoding...'
      : result.ok
        ? `${values.length.toLocaleString('en-US')} items in ${Math.max(1, Math.round(result.ms))} ms`
        : '';
  const setOption = (spec: DecoderOptionSpec, value: string | number): void => onUpdate({ options: { ...inst.options, [spec.id]: value } });
  return (
    <section class="decoder" style={{ '--accent': accent } as Record<string, string>} aria-label={`${def.name} decoder`}>
      <header>
        <h3>{def.name}</h3>
        <span class="meta">{meta}</span>
        <button type="button" class="icon-btn" title="Export decoded data as CSV" onClick={onExport} disabled={!result?.ok}>
          <IconSave size={18} />
        </button>
        <button type="button" class="icon-btn" title={`Remove ${def.name} decoder`} onClick={onRemove}>
          <IconTrash size={18} />
        </button>
      </header>
      {result && !result.ok && <p class="hint error">{result.error}</p>}
      {result?.ok && result.output.warnings.map((w) => <p key={w} class="hint warn">{w}</p>)}

      {def.channels.map((spec) => (
        <Field key={spec.id} label={spec.label} htmlFor={`${inst.uid}-${spec.id}`}>
          <select
            id={`${inst.uid}-${spec.id}`}
            title={spec.description}
            value={inst.channels[spec.id] ?? ''}
            onChange={(e) => {
              const v = (e.currentTarget as HTMLSelectElement).value;
              onUpdate({ channels: { ...inst.channels, [spec.id]: v === '' ? undefined : Number(v) } });
            }}
          >
            <option value="">{spec.required ? 'Choose a channel' : 'Not connected'}</option>
            {capture?.channels.map((ch) => (
              <option key={ch.index} value={ch.index}>
                {ch.name}
              </option>
            ))}
          </select>
        </Field>
      ))}

      {def.options.map((spec) => (
        <Field key={spec.id} label={spec.label} htmlFor={`${inst.uid}-o-${spec.id}`}>
          {spec.kind === 'select' ? (
            <select
              id={`${inst.uid}-o-${spec.id}`}
              value={String(inst.options[spec.id] ?? spec.default)}
              onChange={(e) => setOption(spec, (e.currentTarget as HTMLSelectElement).value)}
            >
              {spec.choices.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          ) : (
            <NumberInput
              id={`${inst.uid}-o-${spec.id}`}
              value={Number(inst.options[spec.id] ?? spec.default)}
              min={spec.min ?? 0}
              max={spec.max ?? 1e12}
              step={spec.step ?? 1}
              onChange={(n) => setOption(spec, n)}
            />
          )}
        </Field>
      ))}

      <div class="row" style={{ marginTop: '6px' }} role="group" aria-label="Rows to show">
        {def.rows.map((r) => {
          const hidden = inst.hiddenRows.includes(r.id);
          return (
            <button
              key={r.id}
              type="button"
              class="btn small"
              aria-pressed={!hidden}
              style={hidden ? { opacity: 0.55, textDecoration: 'line-through' } : undefined}
              onClick={() => onUpdate({ hiddenRows: hidden ? inst.hiddenRows.filter((x) => x !== r.id) : [...inst.hiddenRows, r.id] })}
            >
              {r.label}
            </button>
          );
        })}
        {result?.ok && values.length > 0 && (
          <button type="button" class="btn small quiet" onClick={() => setShowTable(!showTable)}>
            {showTable ? 'Hide values' : 'Show values'}
          </button>
        )}
      </div>

      {showTable && result?.ok && capture && (
        <div class="results">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Row</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              {values.slice(0, TABLE_LIMIT).map((a) => (
                <tr key={`${a.row}-${a.start}`} onClick={() => onJump(a)}>
                  <td>{formatDuration((a.start - (capture.triggerSample ?? 0)) / capture.sampleRate, 6)}</td>
                  <td>{def.rows[a.row]?.label}</td>
                  <td>
                    <span class="kind" style={{ background: ANNOTATION_COLORS[a.kind] }} />
                    {a.texts[0]}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {values.length > TABLE_LIMIT && (
            <p class="hint" style={{ padding: '6px 8px' }}>
              Showing the first {TABLE_LIMIT.toLocaleString('en-US')} of {values.length.toLocaleString('en-US')}. Export CSV for everything.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
