/** Capture library state: the list of kept captures and storage status. */
import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { listCaptures, storageStatus, type CaptureMeta, type StorageStatus } from '../storage/db';

export interface LibraryState {
  readonly items: readonly CaptureMeta[];
  readonly status?: StorageStatus;
  readonly error?: string;
  refresh: () => Promise<void>;
}

export function useLibrary(): LibraryState {
  const [items, setItems] = useState<readonly CaptureMeta[]>([]);
  const [status, setStatus] = useState<StorageStatus | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const refresh = useCallback(async () => {
    try {
      const [list, st] = await Promise.all([listCaptures(), storageStatus()]);
      setItems(list);
      setStatus(st);
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  // Stable identity, so callbacks that depend on the library do not change every render.
  return useMemo(() => ({ items, status, error, refresh }), [items, status, error, refresh]);
}
