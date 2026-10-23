import { setTimeout as delay } from 'node:timers/promises';
import type { ApiDependencies } from './types.ts';

// Injected test clocks can ignore cancellation; check again before continuing.
export async function wait(
  milliseconds: number,
  sleep: ApiDependencies['sleep'],
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  if (sleep) await sleep(milliseconds, signal);
  else await delay(milliseconds, undefined, { signal });
  signal?.throwIfAborted();
}
