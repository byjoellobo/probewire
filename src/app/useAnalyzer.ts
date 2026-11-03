/** Connection and capture lifecycle for the selected analyzer. */
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { AbortedError, LinkClosedError } from '../drivers/serial/link';
import type { CaptureOutcome, CaptureProgress, CaptureRunOptions } from '../drivers/types';
import { PickerCancelled, choiceLabel, connectDevice, type Connected, type DeviceChoice } from './connection';
import type { Settings } from './settings';

export interface Analyzer {
  readonly connected?: Connected;
  readonly connecting: boolean;
  readonly error?: string;
  readonly progress?: CaptureProgress;
  readonly running: boolean;
  connect: (choice?: DeviceChoice) => Promise<Connected | undefined>;
  disconnect: () => Promise<void>;
  capture: (device?: Connected) => Promise<CaptureOutcome | undefined>;
  stop: () => void;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function isAbort(err: unknown): boolean {
  return err instanceof AbortedError || (err instanceof DOMException && err.name === 'AbortError');
}

export function useAnalyzer(settings: Settings, notify: (tone: 'info' | 'error' | 'warn', text: string) => void): Analyzer {
  const [connected, setConnected] = useState<Connected | undefined>(undefined);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [progress, setProgress] = useState<CaptureProgress | undefined>(undefined);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const lastProgress = useRef(0);
  const connectedRef = useRef<Connected | undefined>(undefined);
  connectedRef.current = connected;

  const connect = useCallback(
    async (choice: DeviceChoice = settings.choice): Promise<Connected | undefined> => {
      setConnecting(true);
      setError(undefined);
      try {
        await connectedRef.current?.device.close().catch(() => undefined);
        const dev = await connectDevice(choice, { backend: settings.backend, anyPort: settings.anyPort });
        setConnected(dev);
        return dev;
      } catch (err) {
        if (!(err instanceof PickerCancelled)) setError(`Could not connect to ${choiceLabel(choice)}: ${errorMessage(err)}`);
        return undefined;
      } finally {
        setConnecting(false);
      }
    },
    [settings.choice, settings.backend, settings.anyPort],
  );

  const disconnect = useCallback(async () => {
    abortRef.current?.abort();
    const dev = connectedRef.current;
    setConnected(undefined);
    await dev?.device.close().catch(() => undefined);
  }, []);

  const capture = useCallback(
    async (device?: Connected): Promise<CaptureOutcome | undefined> => {
      const dev = device ?? connectedRef.current;
      if (!dev || abortRef.current) return undefined;
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setProgress({ phase: 'configuring' });
      const opts: CaptureRunOptions = {
        signal: ctrl.signal,
        onProgress: (p) => {
          const now = performance.now();
          if (p.phase !== 'transferring' || now - lastProgress.current > 80) {
            lastProgress.current = now;
            setProgress(p);
          }
        },
      };
      try {
        switch (dev.kind) {
          case 'gusmanb':
            return await dev.device.capture(settings.configs.gusmanb, opts);
          case 'sigrok-pico':
            return await dev.device.capture(settings.configs.pico, opts);
          case 'demo':
            return await dev.device.capture(settings.configs.demo, opts);
        }
      } catch (err) {
        if (isAbort(err)) notify('info', 'Capture stopped.');
        else if (err instanceof LinkClosedError) {
          // Release the port too, or the next connect reports it as already open.
          setConnected(undefined);
          void dev.device.close().catch(() => undefined);
          notify('error', 'The analyzer was disconnected. Plug it back in and connect again.');
        } else notify('error', `Capture failed: ${errorMessage(err)}`);
        return undefined;
      } finally {
        abortRef.current = undefined;
        setProgress(undefined);
      }
    },
    [settings.configs, notify],
  );

  const stop = useCallback(() => abortRef.current?.abort(), []);

  // Notice when the analyzer is unplugged.
  useEffect(() => {
    const onDisconnect = (e: Event): void => {
      const dev = connectedRef.current;
      if (!dev || dev.kind === 'demo' || dev.simulated) return;
      if (dev.port && (e.target as unknown) !== dev.port) return;
      abortRef.current?.abort();
      setConnected(undefined);
      void dev.device.close().catch(() => undefined);
      notify('warn', 'The analyzer was unplugged.');
    };
    const serial = 'serial' in navigator ? navigator.serial : undefined;
    serial?.addEventListener('disconnect', onDisconnect);
    return () => serial?.removeEventListener('disconnect', onDisconnect);
  }, [notify]);

  return { connected, connecting, error, progress, running: progress !== undefined, connect, disconnect, capture, stop };
}
