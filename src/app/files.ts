/** Opening and saving files from the browser. */
import type { Annotation, DecoderDef } from '../decoders/types';

interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: Array<{ description: string; accept: Record<string, string[]> }>;
}
interface WritableFile {
  write(data: BlobPart): Promise<void>;
  close(): Promise<void>;
}
interface FileHandle {
  createWritable(): Promise<WritableFile>;
}
type SaveFilePicker = (options: SaveFilePickerOptions) => Promise<FileHandle>;

export function safeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120) || 'capture';
}

/**
 * Saves bytes, using the File System Access save dialog where available and a
 * download link elsewhere (Android, Firefox, Safari). Returns false if the
 * user cancelled the dialog.
 */
export async function saveFile(input: string | Uint8Array, filename: string, mime: string, description: string, extension: string): Promise<boolean> {
  // A view over the same memory, typed as ArrayBuffer-backed for the Blob APIs.
  const data: BlobPart = typeof input === 'string' ? input : new Uint8Array(input.buffer as ArrayBuffer, input.byteOffset, input.byteLength);
  const picker = (window as unknown as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
  if (picker) {
    try {
      const handle = await picker({ suggestedName: filename, types: [{ description, accept: { [mime]: [extension] } }] });
      const writable = await handle.createWritable();
      await writable.write(data);
      await writable.close();
      return true;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return false;
      // Fall through to a plain download (for example inside an iframe).
    }
  }
  const url = URL.createObjectURL(new Blob([data], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return true;
}

/** Opens the system file picker. Resolves with undefined if nothing was chosen. */
export function pickFile(accept: string): Promise<File | undefined> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.addEventListener('change', () => resolve(input.files?.[0] ?? undefined), { once: true });
    input.addEventListener('cancel', () => resolve(undefined), { once: true });
    input.click();
  });
}

function csvCell(value: string | number): string {
  const s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Decoder output as CSV, one row per annotation, with times in seconds. */
export function annotationsToCsv(def: DecoderDef, annotations: readonly Annotation[], sampleRate: number): string {
  const header = ['start_s', 'end_s', 'start_sample', 'end_sample', 'row', 'kind', 'value', 'text'];
  const lines = [header.join(',')];
  for (const a of annotations) {
    lines.push(
      [
        (a.start / sampleRate).toPrecision(10),
        (a.end / sampleRate).toPrecision(10),
        a.start,
        a.end,
        def.rows[a.row]?.label ?? a.row,
        a.kind,
        a.value ?? '',
        a.texts[0] ?? '',
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}
