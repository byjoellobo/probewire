/**
 * Capture library in IndexedDB.
 *
 * Metadata and sample data live in separate stores so the library list loads
 * without touching megabytes of samples. Sample data is split into chunks to
 * stay well inside per-record limits on mobile browsers.
 */
import { allocWords, createCapture, type AnalogChannel, type Capture, type LogicChannel } from '../core/capture';

const DB_NAME = 'logic-in-a-tab';
const DB_VERSION = 1;
const META_STORE = 'captures';
const CHUNK_STORE = 'chunks';
const CHUNK_BYTES = 8 * 1024 * 1024;

/** A decoder setup saved alongside a capture. */
export interface SavedDecoder {
  readonly uid: string;
  readonly decoderId: string;
  readonly channels: Readonly<Record<string, number | undefined>>;
  readonly options: Readonly<Record<string, number | string>>;
  readonly hiddenRows?: readonly string[];
}

export interface CaptureMeta {
  readonly id: string;
  readonly name: string;
  readonly createdAt: number;
  readonly sampleRate: number;
  readonly sampleCount: number;
  readonly channels: readonly LogicChannel[];
  readonly analog: ReadonlyArray<{ readonly name: string; readonly unit: string }>;
  readonly wordBytes: 1 | 2 | 4;
  readonly triggerSample?: number;
  readonly burstStarts?: readonly number[];
  readonly burstGapsNs?: readonly number[];
  readonly source: string;
  readonly byteSize: number;
  readonly logicChunks: number;
  readonly analogChunks: number;
  readonly decoders: readonly SavedDecoder[];
  readonly savedAt: number;
}

interface ChunkRecord {
  readonly key: string;
  readonly data: ArrayBuffer;
}

let dbPromise: Promise<IDBDatabase> | undefined;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('This browser has no IndexedDB, so captures cannot be saved.'));
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(CHUNK_STORE)) db.createObjectStore(CHUNK_STORE, { keyPath: 'key' });
      };
      req.onsuccess = () => {
        const db = req.result;
        // If another tab upgrades the schema or the browser drops the
        // connection, forget it so the next call reopens instead of failing.
        db.onversionchange = () => {
          db.close();
          dbPromise = undefined;
        };
        db.onclose = () => {
          dbPromise = undefined;
        };
        resolve(db);
      };
      req.onerror = () => reject(req.error ?? new Error('Could not open the capture library.'));
      req.onblocked = () => reject(new Error('The capture library is open in another tab with an older version. Close other tabs and reload.'));
    });
    dbPromise.catch(() => {
      dbPromise = undefined;
    });
  }
  return dbPromise;
}

/** For tests: forget the cached connection. */
export async function resetDbConnection(): Promise<void> {
  if (dbPromise) {
    try {
      (await dbPromise).close();
    } catch {
      // Ignore: the open failed, so there is nothing to close.
    }
  }
  dbPromise = undefined;
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Storage transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('Storage transaction was aborted (the device may be out of space).'));
  });
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Storage request failed'));
  });
}

const logicKey = (id: string, n: number): string => `${id}:L:${n}`;
const analogKey = (id: string, ch: number, n: number): string => `${id}:A${ch}:${n}`;

/** Every chunk key of a capture sorts between these bounds. */
function chunkRange(id: string): IDBKeyRange {
  return IDBKeyRange.bound(`${id}:`, `${id}:\uffff`);
}

/**
 * Queues one put per chunk. Each chunk is copied just before its put (IDB
 * clones the value synchronously), so peak memory stays near one chunk
 * rather than a second copy of the whole capture.
 */
function putChunks(store: IDBObjectStore, view: ArrayBufferView, keyFor: (n: number) => string): void {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  if (bytes.length === 0) {
    store.put({ key: keyFor(0), data: new ArrayBuffer(0) } satisfies ChunkRecord);
    return;
  }
  for (let o = 0, n = 0; o < bytes.length; o += CHUNK_BYTES, n++) {
    store.put({ key: keyFor(n), data: bytes.slice(o, Math.min(o + CHUNK_BYTES, bytes.length)).buffer } satisfies ChunkRecord);
  }
}

export function metaFor(capture: Capture, decoders: readonly SavedDecoder[]): CaptureMeta {
  const logicBytes = capture.samples.byteLength;
  const analogBytes = capture.analog.reduce((n, a) => n + a.data.byteLength, 0);
  return {
    id: capture.id,
    name: capture.name,
    createdAt: capture.createdAt,
    sampleRate: capture.sampleRate,
    sampleCount: capture.sampleCount,
    channels: capture.channels,
    analog: capture.analog.map((a) => ({ name: a.name, unit: a.unit })),
    wordBytes: capture.samples.BYTES_PER_ELEMENT as 1 | 2 | 4,
    triggerSample: capture.triggerSample,
    burstStarts: capture.burstStarts,
    burstGapsNs: capture.burstGapsNs,
    source: capture.source,
    byteSize: logicBytes + analogBytes,
    logicChunks: Math.max(1, Math.ceil(logicBytes / CHUNK_BYTES)),
    analogChunks: Math.max(1, Math.ceil(capture.sampleCount * 4 / CHUNK_BYTES)),
    decoders,
    savedAt: Date.now(),
  };
}

export async function saveCapture(capture: Capture, decoders: readonly SavedDecoder[] = []): Promise<CaptureMeta> {
  const db = await openDb();
  const meta = metaFor(capture, decoders);
  // One transaction: if any write fails (for example the quota is hit), the
  // old version of this capture is left intact instead of half-replaced.
  const tx = db.transaction([META_STORE, CHUNK_STORE], 'readwrite');
  const chunks = tx.objectStore(CHUNK_STORE);
  chunks.delete(chunkRange(capture.id));
  putChunks(chunks, capture.samples, (n) => logicKey(capture.id, n));
  capture.analog.forEach((a, ch) => putChunks(chunks, a.data, (n) => analogKey(capture.id, ch, n)));
  tx.objectStore(META_STORE).put(meta);
  await done(tx);
  return meta;
}

/** Updates metadata only (name, channel names, decoders). */
export async function updateMeta(id: string, patch: Partial<Pick<CaptureMeta, 'name' | 'channels' | 'decoders'>>): Promise<CaptureMeta | undefined> {
  const db = await openDb();
  const tx = db.transaction(META_STORE, 'readwrite');
  const store = tx.objectStore(META_STORE);
  const current = (await request(store.get(id))) as CaptureMeta | undefined;
  if (!current) {
    await done(tx);
    return undefined;
  }
  const next: CaptureMeta = { ...current, ...patch, savedAt: Date.now() };
  store.put(next);
  await done(tx);
  return next;
}

export async function listCaptures(): Promise<CaptureMeta[]> {
  const db = await openDb();
  const tx = db.transaction(META_STORE, 'readonly');
  const all = (await request(tx.objectStore(META_STORE).getAll())) as CaptureMeta[];
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function loadCapture(id: string): Promise<{ capture: Capture; meta: CaptureMeta }> {
  const db = await openDb();
  const tx = db.transaction([META_STORE, CHUNK_STORE], 'readonly');
  const meta = (await request(tx.objectStore(META_STORE).get(id))) as CaptureMeta | undefined;
  if (!meta) throw new Error('That capture is no longer in the library.');
  const chunks = tx.objectStore(CHUNK_STORE);
  /** Reads chunks straight into `target`'s memory, with no intermediate copy. */
  const readInto = async (keys: string[], target: ArrayBufferView): Promise<void> => {
    const out = new Uint8Array(target.buffer, target.byteOffset, target.byteLength);
    let o = 0;
    for (const key of keys) {
      const rec = (await request(chunks.get(key))) as ChunkRecord | undefined;
      if (!rec || o + rec.data.byteLength > out.length) {
        throw new Error('Part of this capture is missing or damaged in storage. It may have been cleared by the browser.');
      }
      out.set(new Uint8Array(rec.data), o);
      o += rec.data.byteLength;
    }
  };
  const samples = allocWords(meta.sampleCount, meta.wordBytes);
  await readInto(
    Array.from({ length: meta.logicChunks }, (_, n) => logicKey(id, n)),
    samples,
  );
  const analog: AnalogChannel[] = [];
  for (let ch = 0; ch < meta.analog.length; ch++) {
    const data = new Float32Array(meta.sampleCount);
    await readInto(
      Array.from({ length: meta.analogChunks }, (_, n) => analogKey(id, ch, n)),
      data,
    );
    analog.push({ ...meta.analog[ch], data });
  }
  const capture = createCapture({
    id: meta.id,
    name: meta.name,
    createdAt: meta.createdAt,
    sampleRate: meta.sampleRate,
    channels: meta.channels,
    samples,
    analog,
    triggerSample: meta.triggerSample,
    burstStarts: meta.burstStarts,
    burstGapsNs: meta.burstGapsNs,
    source: meta.source,
  });
  return { capture, meta };
}

export async function deleteCapture(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([META_STORE, CHUNK_STORE], 'readwrite');
  tx.objectStore(CHUNK_STORE).delete(chunkRange(id));
  tx.objectStore(META_STORE).delete(id);
  await done(tx);
}

export interface StorageStatus {
  readonly usedBytes?: number;
  readonly quotaBytes?: number;
  readonly persisted: boolean;
}

export async function storageStatus(): Promise<StorageStatus> {
  if (typeof navigator === 'undefined' || !navigator.storage) return { persisted: false };
  const [estimate, persisted] = await Promise.all([
    navigator.storage.estimate?.().catch(() => undefined),
    navigator.storage.persisted?.().catch(() => false) ?? Promise.resolve(false),
  ]);
  return { usedBytes: estimate?.usage, quotaBytes: estimate?.quota, persisted: !!persisted };
}

/** Asks the browser not to evict the library under storage pressure. */
export async function requestPersistence(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}
