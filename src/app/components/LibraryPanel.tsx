/** Captures kept in browser storage. */
import { useState } from 'preact/hooks';
import { formatBytes, formatCount, formatDuration, formatFrequency } from '../../core/units';
import type { CaptureMeta, StorageStatus } from '../../storage/db';
import { IconOpen, IconPencil, IconSave, IconTrash, Logo } from './icons';

interface LibraryPanelProps {
  readonly items: readonly CaptureMeta[];
  readonly currentId?: string;
  readonly currentSaved: boolean;
  readonly hasCapture: boolean;
  readonly status?: StorageStatus;
  readonly autoSave: boolean;
  readonly onAutoSave: (v: boolean) => void;
  readonly onOpen: (id: string) => void;
  readonly onRename: (id: string, name: string) => void;
  readonly onDelete: (id: string) => void;
  readonly onExport: (id: string) => void;
  readonly onImport: () => void;
  readonly onSaveCurrent: () => void;
  readonly onPersist: () => void;
  /** Touch-first device: no drag-and-drop hint. */
  readonly coarsePointer: boolean;
}

const REPO = 'https://github.com/byjoellobo/probewire';

export function LibraryPanel(props: LibraryPanelProps) {
  const { items, status } = props;
  const [renaming, setRenaming] = useState<string | undefined>(undefined);
  const [confirmDelete, setConfirmDelete] = useState<string | undefined>(undefined);
  const used = status?.usedBytes;
  const quota = status?.quotaBytes;
  return (
    <>
      <div class="group">
        <h2>Files</h2>
        <div class="row">
          <button type="button" class="btn" onClick={props.onImport}>
            <IconOpen size={18} /> Open .sr file
          </button>
          {props.hasCapture && !props.currentSaved && (
            <button type="button" class="btn" onClick={props.onSaveCurrent}>
              Keep current capture
            </button>
          )}
        </div>
        <p class="hint">
          Opens sigrok session files from PulseView or sigrok-cli.{props.coarsePointer ? '' : ' You can also drop a file onto the window.'}
        </p>
        <label class="check">
          <input type="checkbox" checked={props.autoSave} onChange={(e) => props.onAutoSave((e.currentTarget as HTMLInputElement).checked)} />
          Keep every new capture in the library
        </label>
      </div>

      <div class="group">
        <h2>
          Library <small>{items.length === 0 ? 'empty' : `${items.length} capture${items.length === 1 ? '' : 's'}`}</small>
        </h2>
        {items.length === 0 && <p class="hint">Captures you keep are stored in this browser, on this device, and work offline.</p>}
        {items.map((m) => (
          <div key={m.id} class={`lib-item${m.id === props.currentId ? ' current' : ''}`}>
            {renaming === m.id ? (
              <input
                class="input"
                aria-label="New capture name"
                value={m.name}
                maxLength={80}
                ref={(el) => el?.focus()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    props.onRename(m.id, (e.currentTarget as HTMLInputElement).value.trim() || m.name);
                    setRenaming(undefined);
                  }
                  if (e.key === 'Escape') setRenaming(undefined);
                }}
                onBlur={(e) => {
                  props.onRename(m.id, (e.currentTarget as HTMLInputElement).value.trim() || m.name);
                  setRenaming(undefined);
                }}
              />
            ) : (
              <span class="lib-title">
                <button type="button" class="lib-name" title={`Open ${m.name}`} onClick={() => props.onOpen(m.id)}>
                  {m.name}
                </button>
                {m.id === props.currentId && <span class="badge">open</span>}
              </span>
            )}
            <div class="lib-actions">
              <button type="button" class="icon-btn" title="Rename" onClick={() => setRenaming(m.id)}>
                <IconPencil size={17} />
              </button>
              <button type="button" class="icon-btn" title="Save as .sr file" onClick={() => props.onExport(m.id)}>
                <IconSave size={17} />
              </button>
              {confirmDelete === m.id ? (
                <button
                  type="button"
                  class="btn small stop"
                  onClick={() => {
                    props.onDelete(m.id);
                    setConfirmDelete(undefined);
                  }}
                  onBlur={() => setConfirmDelete(undefined)}
                >
                  Delete
                </button>
              ) : (
                <button type="button" class="icon-btn" title="Delete" onClick={() => setConfirmDelete(m.id)}>
                  <IconTrash size={17} />
                </button>
              )}
            </div>
            <div class="lib-meta">
              <span>{m.source}</span>
              <span>{formatDuration(m.sampleCount / m.sampleRate, 3)}</span>
              <span>{formatFrequency(m.sampleRate)}</span>
              <span>{formatCount(m.sampleCount)} samples</span>
              <span>{formatBytes(m.byteSize)}</span>
            </div>
          </div>
        ))}
      </div>

      <div class="group">
        <h2>Storage</h2>
        {used !== undefined && quota !== undefined ? (
          <>
            <p class="hint" style={{ marginTop: 0 }}>
              {formatBytes(used)} used of {formatBytes(quota)} available to this site.
            </p>
            <div class="meter" role="img" aria-label={`${Math.round((used / quota) * 100)}% of storage used`}>
              <div style={{ width: `${Math.min(100, (used / quota) * 100)}%` }} />
            </div>
          </>
        ) : (
          <p class="hint" style={{ marginTop: 0 }}>
            This browser does not report storage use.
          </p>
        )}
        {status && !status.persisted && (
          <>
            <p class="hint">The browser may clear the library when the device runs low on space.</p>
            <button type="button" class="btn small" style={{ marginTop: '8px' }} onClick={props.onPersist}>
              Ask to keep the library
            </button>
          </>
        )}
        {status?.persisted && <p class="hint">The browser has agreed to keep the library.</p>}
      </div>

      <div class="group">
        <h2>About</h2>
        <div class="about">
          <Logo size={34} />
          <p>
            Probewire {__APP_VERSION__}
            <br />
            <span class="hint">MIT licensed. Runs entirely in this browser.</span>
          </p>
        </div>
        <div class="links">
          <a href={`${REPO}/blob/main/docs/getting-started.md`} target="_blank" rel="noopener noreferrer">
            Guide
          </a>
          <a href={`${REPO}/blob/main/docs/hardware.md`} target="_blank" rel="noopener noreferrer">
            Flashing a Pico
          </a>
          <a href={`${REPO}/releases`} target="_blank" rel="noopener noreferrer">
            What's new
          </a>
          <a href={`${REPO}/issues/new/choose`} target="_blank" rel="noopener noreferrer">
            Report a problem
          </a>
          <a href={REPO} target="_blank" rel="noopener noreferrer">
            Source code
          </a>
        </div>
      </div>
    </>
  );
}
