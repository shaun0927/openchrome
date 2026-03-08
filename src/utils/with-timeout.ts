import { OpenChromeTimeoutError } from '../errors/timeout';

/**
 * Race a promise against a timeout. Rejects with an OpenChromeTimeoutError if the timeout fires first.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label = 'Operation'): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new OpenChromeTimeoutError(label, ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
