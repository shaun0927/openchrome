/// <reference types="jest" />

import { EventEmitter } from 'events';
import { launchManagedChrome, resolveChromePath } from './chrome-launcher';

describe('benchmark Chrome launcher', () => {
  test('resolves explicit chrome path from env', () => {
    expect(resolveChromePath({ OPENCHROME_BENCH_CHROME_PATH: '/tmp/chrome' } as NodeJS.ProcessEnv, 'linux')).toBe('/tmp/chrome');
  });

  test('launches with benchmark-safe flags and waits for probe', async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const fakeProc = Object.assign(new EventEmitter(), { pid: 123, killed: false, kill() { this.killed = true; return true; } });
    const managed = await launchManagedChrome({
      chromePath: '/bin/chrome',
      port: 9333,
      userDataDir: '/tmp/profile',
      probe: async () => true,
      spawnImpl: ((cmd: string, args: string[]) => { calls.push({ cmd, args }); return fakeProc; }) as never,
    });
    expect(managed.endpoint).toBe('http://127.0.0.1:9333');
    expect(calls[0].args).toContain('--remote-debugging-port=9333');
    expect(calls[0].args).toContain('--user-data-dir=/tmp/profile');
    await managed.close();
    expect(fakeProc.killed).toBe(true);
  });
});
