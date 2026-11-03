/** Application shell: wires the analyzer, workspace, decoders, library and views together. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { registerSW } from 'virtual:pwa-register';
import { withChannelName, type Capture } from '../core/capture';
import { formatBytes } from '../core/units';
import { getDecoder } from '../decoders/registry';
import type { Annotation } from '../decoders/types';
import { detectSupport } from '../drivers/serial/ports';
import { readSr, writeSr } from '../formats/srzip';
import { deleteCapture, loadCapture, requestPersistence, saveCapture, updateMeta, type SavedDecoder } from '../storage/db';
import { DecoderPanel } from './components/DecoderPanel';
import { DevicePanel } from './components/DevicePanel';
import { EmptyState } from './components/EmptyState';
import { Header } from './components/Header';
import { IconDecode, IconDevice, IconLibrary, IconWave } from './components/icons';
import { LibraryPanel } from './components/LibraryPanel';
import { StatusBar } from './components/StatusBar';
import { Toasts, useToasts } from './components/Toasts';
import { TraceView, type Cursors, type Probe, type TraceViewHandle } from './components/TraceView';
import { configErrors } from './components/CaptureForms';
import { annotationsToCsv, pickFile, safeFilename, saveFile } from './files';
import { COMPACT_ROW_HEIGHTS, ROW_HEIGHTS, buildRows, decoderAccent, probeReadout } from './rows';
import { defaultSettings, loadSettings, saveSettings, type Settings } from './settings';
import { errorMessage, useAnalyzer } from './useAnalyzer';
import { useLibrary } from './useLibrary';
import {
  buildWorkspace,
  decoderKey,
  newDecoderInstance,
  reconcileChannels,
  runDecoder,
  type DecoderInstance,
  type DecoderResult,
  type Workspace,
} from './workspace';

type Tab = 'device' | 'decoders' | 'library';

/** Largest .sr file accepted; decompressed data is capped separately in srzip. */
const MAX_FILE_BYTES = 1024 ** 3;

const TAB_LABELS: Record<Tab, string> = { device: 'Device', decoders: 'Decoders', library: 'Library' };

function useCompact(): boolean {
  const query = '(max-width: 820px)';
  const [compact, setCompact] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = (): void => setCompact(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return compact;
}

export function App() {
  const support = useMemo(detectSupport, []);
  const [settings, setSettings] = useState<Settings>(() => loadSettings(defaultSettings(support.likelyMobile, support.webSerial)));
  useEffect(() => saveSettings(settings), [settings]);
  const patch = useCallback((p: Partial<Settings>) => setSettings((s) => ({ ...s, ...p })), []);

  const toasts = useToasts();
  const notify = toasts.push;
  const analyzer = useAnalyzer(settings, notify);
  const library = useLibrary();
  const compact = useCompact();

  const [ws, setWs] = useState<Workspace | undefined>(undefined);
  const [savedId, setSavedId] = useState<string | undefined>(undefined);
  const [results, setResults] = useState<Readonly<Record<string, DecoderResult>>>({});
  const [cursors, setCursors] = useState<Cursors>({});
  const [probe, setProbe] = useState<Probe | undefined>(undefined);
  const [selected, setSelected] = useState<Annotation | undefined>(undefined);
  const [tab, setTab] = useState<Tab>('device');
  const [sheetOpen, setSheetOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const traceRef = useRef<TraceViewHandle>(null);
  const cacheRef = useRef(new Map<string, DecoderResult>());
  /** Id of the capture on screen, readable after awaits without stale closures. */
  const shownIdRef = useRef<string | undefined>(undefined);
  shownIdRef.current = ws?.capture.id;

  const openTab = (t: Tab): void => {
    setTab(t);
    setSheetOpen(true);
  };

  // ------------------------------------------------------------ captures

  const showCapture = useCallback((capture: Capture, keptId?: string, decoders?: readonly DecoderInstance[]) => {
    cacheRef.current = new Map();
    shownIdRef.current = capture.id;
    setWs(buildWorkspace(capture));
    setSavedId(keptId);
    setCursors({});
    setProbe(undefined);
    setSelected(undefined);
    setSettings((s) => ({ ...s, decoders: (decoders ?? s.decoders).map((d) => reconcileChannels(d, capture)) }));
    setSheetOpen(false);
  }, []);

  const keep = useCallback(
    async (capture: Capture): Promise<void> => {
      try {
        await saveCapture(capture, settings.decoders as readonly SavedDecoder[]);
        // The user may have opened something else while this was saving.
        if (shownIdRef.current === capture.id) setSavedId(capture.id);
        await library.refresh();
      } catch (err) {
        notify('error', `Could not keep the capture in the library: ${errorMessage(err)} Delete older captures or save it as a .sr file.`);
      }
    },
    [settings.decoders, library, notify],
  );

  const runCapture = useCallback(async () => {
    let dev = analyzer.connected;
    if (!dev) {
      const hardware = settings.choice === 'gusmanb' || settings.choice === 'sigrok-pico';
      if (hardware) {
        openTab('device');
        return;
      }
      dev = await analyzer.connect();
      if (!dev) return;
    }
    const outcome = await analyzer.capture(dev);
    if (!outcome) return;
    showCapture(outcome.capture);
    outcome.warnings.forEach((w) => notify('warn', w));
    if (settings.autoSave) await keep(outcome.capture);
  }, [analyzer, settings.choice, settings.autoSave, showCapture, keep, notify]);

  const runDemo = useCallback(async () => {
    patch({ choice: 'demo' });
    const dev = await analyzer.connect('demo');
    if (!dev) return;
    const outcome = await analyzer.capture(dev);
    if (!outcome) return;
    // A first-time visitor sees decoding straight away.
    const decoders = settings.decoders.length > 0 ? undefined : ['uart', 'i2c', 'spi'].map((id) => newDecoderInstance(id, outcome.capture));
    showCapture(outcome.capture, undefined, decoders);
    if (settings.autoSave) await keep(outcome.capture);
  }, [analyzer, patch, settings.decoders.length, settings.autoSave, showCapture, keep]);

  const openFile = useCallback(
    async (file: File) => {
      if (file.size > MAX_FILE_BYTES) {
        notify('error', `${file.name} is ${formatBytes(file.size)}, more than this app can open (${formatBytes(MAX_FILE_BYTES)}).`);
        return;
      }
      try {
        const { capture, warnings } = await readSr(new Uint8Array(await file.arrayBuffer()), file.name.replace(/\.sr$/i, ''));
        showCapture(capture);
        warnings.forEach((w) => notify('warn', w));
        notify('ok', `Opened ${file.name}.`);
        if (settings.autoSave) await keep(capture);
      } catch (err) {
        notify('error', `Could not open ${file.name}: ${errorMessage(err)}`);
      }
    },
    [showCapture, notify, settings.autoSave, keep],
  );

  const importFile = useCallback(async () => {
    const file = await pickFile('.sr,application/zip');
    if (file) await openFile(file);
  }, [openFile]);

  const exportCapture = useCallback(
    async (capture: Capture) => {
      try {
        const bytes = await writeSr(capture);
        await saveFile(bytes, `${safeFilename(capture.name)}.sr`, 'application/zip', 'sigrok session', '.sr');
      } catch (err) {
        notify('error', `Could not save the .sr file: ${errorMessage(err)}`);
      }
    },
    [notify],
  );

  const openFromLibrary = useCallback(
    async (id: string) => {
      try {
        const { capture, meta } = await loadCapture(id);
        const decoders = meta.decoders.length > 0 ? meta.decoders.map(toInstance) : undefined;
        showCapture(capture, id, decoders);
      } catch (err) {
        notify('error', errorMessage(err));
      }
    },
    [showCapture, notify],
  );

  const renameChannel = useCallback(
    (index: number, name: string) => {
      if (!ws) return;
      const capture = withChannelName(ws.capture, index, name);
      setWs({ ...ws, capture });
      if (savedId === capture.id) {
        updateMeta(capture.id, { channels: capture.channels })
          .then(() => library.refresh())
          .catch((err: unknown) => notify('warn', `The new name was not saved to the library: ${errorMessage(err)}`));
      }
    },
    [ws, savedId, library, notify],
  );

  // Drag and drop .sr files; PWA file handling.
  useEffect(() => {
    type LaunchParams = { files: Array<{ getFile(): Promise<File> }> };
    const lq = (window as unknown as { launchQueue?: { setConsumer(cb: (p: LaunchParams) => void): void } }).launchQueue;
    lq?.setConsumer(async (params) => {
      for (const handle of params.files) await openFile(await handle.getFile());
    });
  }, [openFile]);

  useEffect(() => {
    const update = registerSW({
      onNeedRefresh: () => notify('info', 'A new version is ready.', { label: 'Reload', run: () => void update(true) }),
      onOfflineReady: () => notify('ok', 'Logic in a Tab now works offline.'),
    });
  }, [notify]);

  // ------------------------------------------------------------ decoders

  useEffect(() => {
    if (!ws) {
      setResults({});
      return;
    }
    // One decoder per task, so a long decode never blocks input for the whole batch.
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending = [...settings.decoders];
    const next: Record<string, DecoderResult> = {};
    const step = (): void => {
      if (cancelled) return;
      const inst = pending.shift();
      if (!inst) {
        setResults({ ...next });
        return;
      }
      const key = decoderKey(inst, ws.capture.id);
      const res = cacheRef.current.get(key) ?? runDecoder(inst, ws);
      cacheRef.current.set(key, res);
      next[inst.uid] = res;
      timer = setTimeout(step, 0);
    };
    timer = setTimeout(step, 0);
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [ws, settings.decoders]);

  // Keep decoder setups with the capture they were made for.
  useEffect(() => {
    if (!savedId) return;
    const timer = setTimeout(() => {
      updateMeta(savedId, { decoders: settings.decoders as readonly SavedDecoder[] }).catch(() => {
        // Best effort: the capture itself is safe; only its decoder setup was not updated.
      });
    }, 800);
    return () => clearTimeout(timer);
  }, [savedId, settings.decoders]);

  const rows = useMemo(
    () => (ws ? buildRows(ws, settings.decoders, results, compact ? COMPACT_ROW_HEIGHTS : ROW_HEIGHTS) : []),
    [ws, settings.decoders, results, compact],
  );
  const readout = useMemo(() => (ws ? probeReadout(ws, rows, probe) : undefined), [ws, rows, probe]);

  const exportCsv = (uid: string): void => {
    const inst = settings.decoders.find((d) => d.uid === uid);
    const res = results[uid];
    const def = inst && getDecoder(inst.decoderId);
    if (!ws || !def || !res?.ok) return;
    const csv = annotationsToCsv(def, res.output.annotations, ws.capture.sampleRate);
    void saveFile(csv, `${safeFilename(ws.capture.name)}-${def.id}.csv`, 'text/csv', 'CSV', '.csv');
  };

  // ------------------------------------------------------------ render

  const dev = analyzer.connected;
  const formErrors = dev
    ? configErrors(dev.kind, { info: dev.kind === 'gusmanb' ? dev.device.info : undefined, identity: dev.kind === 'sigrok-pico' ? dev.device.identity : undefined }, settings.configs)
    : [];
  const hardwareChoice = settings.choice === 'gusmanb' || settings.choice === 'sigrok-pico';
  const canCapture = !analyzer.connecting && formErrors.length === 0 && (!!dev || !hardwareChoice);

  const panel = (
    <>
      {tab === 'device' && (
        <DevicePanel
          choice={settings.choice}
          onChoice={(choice) => patch({ choice })}
          backend={settings.backend}
          onBackend={(backend) => patch({ backend })}
          anyPort={settings.anyPort}
          onAnyPort={(anyPort) => patch({ anyPort })}
          connected={dev}
          connecting={analyzer.connecting}
          busy={analyzer.running}
          error={analyzer.error}
          onConnect={() => void analyzer.connect()}
          onDisconnect={() => void analyzer.disconnect()}
          configs={settings.configs}
          onConfigs={(configs) => patch({ configs })}
          support={support}
        />
      )}
      {tab === 'decoders' && (
        <DecoderPanel
          capture={ws?.capture}
          instances={settings.decoders}
          results={results}
          onChange={(decoders) => patch({ decoders })}
          onJump={(a) => {
            setSelected(a);
            traceRef.current?.goTo(a.start, a.end);
            if (compact) setSheetOpen(false);
          }}
          onExportCsv={exportCsv}
          accentFor={(uid) => decoderAccent(settings.decoders, uid)}
        />
      )}
      {tab === 'library' && (
        <LibraryPanel
          items={library.items}
          currentId={ws?.capture.id}
          currentSaved={!!ws && savedId === ws.capture.id}
          hasCapture={!!ws}
          status={library.status}
          autoSave={settings.autoSave}
          onAutoSave={(autoSave) => patch({ autoSave })}
          onOpen={(id) => void openFromLibrary(id)}
          onRename={(id, name) => {
            updateMeta(id, { name })
              .then(() => library.refresh())
              .catch((err: unknown) => notify('error', `Could not rename: ${errorMessage(err)}`));
            if (ws?.capture.id === id) setWs({ ...ws, capture: { ...ws.capture, name } });
          }}
          onDelete={(id) => {
            deleteCapture(id)
              .then(() => {
                setSavedId((current) => (current === id ? undefined : current));
                return library.refresh();
              })
              .catch((err: unknown) => notify('error', `Could not delete: ${errorMessage(err)}`));
          }}
          onExport={(id) => void loadCapture(id).then(({ capture }) => exportCapture(capture)).catch((err: unknown) => notify('error', errorMessage(err)))}
          onImport={() => void importFile()}
          onSaveCurrent={() => ws && void keep(ws.capture)}
          onPersist={() =>
            void requestPersistence().then((ok) => {
              notify(ok ? 'ok' : 'warn', ok ? 'The browser will keep the library.' : 'The browser declined. Installing the app usually helps.');
              void library.refresh();
            })
          }
        />
      )}
    </>
  );

  return (
    <div
      class="shell"
      onDragOver={(e) => {
        if (e.dataTransfer?.types.includes('Files')) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.relatedTarget === null) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const file = e.dataTransfer?.files[0];
        if (file) void openFile(file);
      }}
    >
      <Header
        deviceTitle={dev?.device.summary.title}
        connecting={analyzer.connecting}
        running={analyzer.running}
        progress={analyzer.progress}
        canCapture={canCapture}
        captureHint={formErrors[0] ?? (!dev && hardwareChoice ? 'Connect an analyzer first' : undefined)}
        hasCapture={!!ws}
        hasCursors={cursors.a !== undefined || cursors.b !== undefined}
        onDevice={() => openTab('device')}
        onCapture={() => void runCapture()}
        onStop={analyzer.stop}
        onOpen={() => void importFile()}
        onSave={() => ws && void exportCapture(ws.capture)}
        onZoom={(f) => traceRef.current?.zoom(f)}
        onFit={() => traceRef.current?.fit()}
        onClearCursors={() => setCursors({})}
      />
      <aside class={`panel${sheetOpen ? ' open' : ''}`} aria-label="Settings">
        <div class="sheet-handle" />
        <div class="tabs" role="tablist">
          {(Object.keys(TAB_LABELS) as Tab[]).map((t) => (
            <button key={t} type="button" role="tab" class="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
              {TAB_LABELS[t]}
            </button>
          ))}
        </div>
        <div class="tab-body" role="tabpanel">
          {panel}
        </div>
      </aside>
      <main class="main" onClick={() => compact && sheetOpen && setSheetOpen(false)}>
        {ws ? (
          <TraceView
            ws={ws}
            rows={rows}
            cursors={cursors}
            onCursors={setCursors}
            probe={probe}
            onProbe={setProbe}
            selected={selected}
            onRename={renameChannel}
            handleRef={traceRef}
          />
        ) : (
          <EmptyState support={support} busy={analyzer.running || analyzer.connecting} onDemo={() => void runDemo()} onConnect={() => openTab('device')}
            onOpen={() => void importFile()}
            recent={library.items[0] ? { name: library.items[0].name, onReopen: () => void openFromLibrary(library.items[0].id) } : undefined}
          />
        )}
        {dragging && <div class="dropzone">Drop a .sr file to open it</div>}
      </main>
      <StatusBar capture={ws?.capture} cursors={cursors} readout={readout} progress={analyzer.progress} />
      <nav class="bottom-tabs" role="tablist" aria-label="Panels">
        <button type="button" role="tab" aria-selected={!sheetOpen} onClick={() => setSheetOpen(false)}>
          <IconWave /> Trace
        </button>
        <button type="button" role="tab" aria-selected={sheetOpen && tab === 'device'} onClick={() => openTab('device')}>
          <IconDevice /> Device
        </button>
        <button type="button" role="tab" aria-selected={sheetOpen && tab === 'decoders'} onClick={() => openTab('decoders')}>
          <IconDecode /> Decoders
        </button>
        <button type="button" role="tab" aria-selected={sheetOpen && tab === 'library'} onClick={() => openTab('library')}>
          <IconLibrary /> Library
        </button>
      </nav>
      <Toasts api={toasts} />
    </div>
  );
}

function toInstance(d: SavedDecoder): DecoderInstance {
  return { uid: d.uid, decoderId: d.decoderId, channels: d.channels, options: d.options, hiddenRows: d.hiddenRows ?? [] };
}
