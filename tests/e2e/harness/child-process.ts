import type { ChildProcess } from 'child_process';

const DEFAULT_SIGNAL_WAIT_MS = 5_000;

export function hasChildExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function signalAndWait(
  child: ChildProcess,
  signal: NodeJS.Signals,
  timeoutMs: number,
): Promise<boolean> {
  if (hasChildExited(child)) return true;

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(hasChildExited(child)), timeoutMs);
    timer.unref();

    child.once('exit', onExit);
    try {
      child.kill(signal);
    } catch {
      // The timeout check below distinguishes an already-exited child from a
      // process that ignored or could not receive the signal.
    }
    if (hasChildExited(child)) finish(true);
  });
}

export async function terminateChild(
  child: ChildProcess,
  options: {
    initialSignal?: NodeJS.Signals;
    initialWaitMs?: number;
    killWaitMs?: number;
  } = {},
): Promise<void> {
  if (hasChildExited(child)) return;

  const initialSignal = options.initialSignal ?? 'SIGTERM';
  const initialWaitMs = options.initialWaitMs ?? DEFAULT_SIGNAL_WAIT_MS;
  const killWaitMs = options.killWaitMs ?? DEFAULT_SIGNAL_WAIT_MS;

  if (await signalAndWait(child, initialSignal, initialWaitMs)) return;
  if (initialSignal !== 'SIGKILL' && await signalAndWait(child, 'SIGKILL', killWaitMs)) return;

  throw new Error(`Child process ${child.pid ?? 'unknown'} did not exit after ${initialSignal}`);
}
