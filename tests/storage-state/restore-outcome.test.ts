import type { Page } from 'puppeteer-core';
import { StorageStateManager } from '../../src/storage-state/storage-state-manager';
import { readFileSafe, writeFileAtomicSafe } from '../../src/core/fs/atomic-file';

jest.mock('../../src/core/fs/atomic-file', () => ({
  readFileSafe: jest.fn(), writeFileAtomicSafe: jest.fn(),
}));

describe('storage restoration outcomes', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    (readFileSafe as jest.Mock).mockResolvedValue({ success: true, data: {
      version: 1, cookies: [{ name: 'session', value: 'secret', session: true }],
      localStorage: { 'https://example.test': { token: 'secret' } },
    } });
  });
  afterEach(() => jest.useRealTimers());

  it('reports uncertain timeout, blocks saves, and never dispatches later storage steps', async () => {
    let settle!: (value: unknown) => void;
    const send = jest.fn().mockImplementation(() => new Promise(resolve => { settle = resolve; }));
    const page = { evaluate: jest.fn() } as unknown as Page;
    const manager = new StorageStateManager();
    const restore = manager.restoreDetailed(page, { send }, 'state.json', 10);
    await jest.advanceTimersByTimeAsync(10);
    expect(await restore).toEqual({ status: 'timed_out', execution: 'unknown', authentication: 'unverified' });
    await manager.save(page, { send }, 'state.json');
    expect(writeFileAtomicSafe).not.toHaveBeenCalled();
    expect((await manager.restoreDetailed(page, { send }, 'state.json')).execution).toBe('not_started');
    settle({});
    await jest.advanceTimersByTimeAsync(0);
    expect(page.evaluate).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    await manager.save(page, { send }, 'state.json');
    expect(writeFileAtomicSafe).not.toHaveBeenCalled();
  });

  it('reports storage failure without leaking the exception or credentials', async () => {
    const page = { evaluate: jest.fn().mockRejectedValue(new Error('secret')) } as unknown as Page;
    const result = await new StorageStateManager().restoreDetailed(page, { send: jest.fn().mockResolvedValue({}) }, 'state.json');
    expect(result).toEqual({ status: 'failed', execution: 'partial', authentication: 'unverified' });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('allows another attempt after an unavailable snapshot', async () => {
    (readFileSafe as jest.Mock).mockResolvedValue({ success: false });
    const manager = new StorageStateManager();
    const page = {} as Page;
    const client = { send: jest.fn() };
    expect((await manager.restoreDetailed(page, client, 'state.json')).status).toBe('unavailable');
    expect((await manager.restoreDetailed(page, client, 'state.json')).status).toBe('unavailable');
    expect(readFileSafe).toHaveBeenCalledTimes(2);
  });

  it('preserves an unreadable snapshot rather than overwriting it during shutdown', async () => {
    (readFileSafe as jest.Mock).mockResolvedValue({ success: false, error: 'JSON parse error' });
    const manager = new StorageStateManager();
    const client = { send: jest.fn() };
    const page = {} as Page;
    expect(await manager.restoreDetailed(page, client, 'state.json')).toMatchObject({
      status: 'unavailable', reason: 'unreadable', execution: 'not_started',
    });
    await manager.save(page, client, 'state.json');
    expect(writeFileAtomicSafe).not.toHaveBeenCalled();
    expect(client.send).not.toHaveBeenCalled();
  });
  it('does not replace a fresh live session with an older saved cookie', async () => {
    const send = jest.fn().mockResolvedValue({ cookies: [{ name: 'session', value: 'fresh', session: true }] });
    const page = { evaluate: jest.fn().mockResolvedValue('https://example.test') } as unknown as Page;
    expect((await new StorageStateManager().restoreDetailed(page, { send }, 'state.json')).status).toBe('restored');
    expect(send.mock.calls.filter(call => call[1] === 'Network.setCookies')).toEqual([]);
  });

});
