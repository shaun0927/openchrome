/// <reference types="jest" />

import { StorageStateManager, StorageState, CDPClientLike } from '../../src/storage-state/storage-state-manager';
import { writeFileAtomicSafe, readFileSafe } from '../../src/utils/atomic-file';
import { Page } from 'puppeteer-core';

jest.mock('../../src/utils/atomic-file', () => ({
  writeFileAtomicSafe: jest.fn().mockResolvedValue(undefined),
  readFileSafe: jest.fn(),
}));

const mockWriteFileAtomicSafe = writeFileAtomicSafe as jest.MockedFunction<typeof writeFileAtomicSafe>;
const mockReadFileSafe = readFileSafe as jest.MockedFunction<typeof readFileSafe>;

/**
 * Build a mock Page where evaluate() returns different values per call.
 * Calls are matched in order: first call returns responses[0], second returns responses[1], etc.
 * If a call index exceeds the responses array, returns undefined.
 */
function makeMockPageMultiEval(responses: Array<unknown>): jest.Mocked<Pick<Page, 'evaluate'>> {
  let callIndex = 0;
  return {
    evaluate: jest.fn().mockImplementation(() => {
      const response = responses[callIndex] ?? undefined;
      callIndex++;
      return Promise.resolve(response);
    }),
  } as unknown as jest.Mocked<Pick<Page, 'evaluate'>>;
}

function makeMockCdpClient(sendResult?: unknown): jest.Mocked<CDPClientLike> {
  return {
    send: jest.fn().mockResolvedValue(sendResult ?? {}),
  } as unknown as jest.Mocked<CDPClientLike>;
}

describe('StorageStateManager origin-scoped localStorage', () => {
  let manager: StorageStateManager;

  beforeEach(() => {
    manager = new StorageStateManager();
    jest.clearAllMocks();
  });

  afterEach(() => {
    manager.stopWatchdog();
  });

  // ─── restore: origin-scoped format ────────────────────────────────────────

  test('restore only injects matching origin keys — non-matching origin gets nothing', async () => {
    // State has data for https://example.com
    const state: StorageState = {
      version: 1,
      timestamp: Date.now(),
      cookies: [],
      localStorage: {
        'https://example.com': { theme: 'dark', lang: 'en' },
      },
    };
    mockReadFileSafe.mockResolvedValue({ success: true, data: state });

    // Page is on a different origin
    // First evaluate call returns pageOrigin, second would be the setItem call (should not happen)
    const page = makeMockPageMultiEval(['https://other.com']);
    const cdpClient = makeMockCdpClient();

    const result = await manager.restore(page as unknown as Page, cdpClient, '/tmp/state.json');

    expect(result).toBe(true);
    // evaluate was called once (to get origin) — the setItem evaluate should NOT have been called
    expect(page.evaluate).toHaveBeenCalledTimes(1);
  });

  test('restore injects keys when origin matches', async () => {
    const state: StorageState = {
      version: 1,
      timestamp: Date.now(),
      cookies: [],
      localStorage: {
        'https://example.com': { theme: 'dark', lang: 'en' },
      },
    };
    mockReadFileSafe.mockResolvedValue({ success: true, data: state });

    // Page is on the matching origin
    // First evaluate call returns origin, second is the actual setItem injection
    const page = makeMockPageMultiEval(['https://example.com', undefined]);
    const cdpClient = makeMockCdpClient();

    const result = await manager.restore(page as unknown as Page, cdpClient, '/tmp/state.json');

    expect(result).toBe(true);
    // evaluate called twice: once to get origin, once to inject localStorage
    expect(page.evaluate).toHaveBeenCalledTimes(2);
    // Second call should have received the matching origin data
    const secondCallArgs = (page.evaluate as jest.Mock).mock.calls[1];
    expect(secondCallArgs[1]).toEqual({ theme: 'dark', lang: 'en' });
  });

  test('restore handles legacy flat format (backward compat) — injects all keys', async () => {
    // Old flat format: {"key": "value"}
    const state: StorageState = {
      version: 1,
      timestamp: Date.now(),
      cookies: [],
      localStorage: { theme: 'dark', lang: 'en' } as Record<string, string>,
    };
    mockReadFileSafe.mockResolvedValue({ success: true, data: state });

    // First call returns origin, second is the setItem call
    const page = makeMockPageMultiEval(['https://example.com', undefined]);
    const cdpClient = makeMockCdpClient();

    const result = await manager.restore(page as unknown as Page, cdpClient, '/tmp/state.json');

    expect(result).toBe(true);
    // evaluate called twice: once to get origin, once to inject all legacy keys
    expect(page.evaluate).toHaveBeenCalledTimes(2);
    // Second call should have received the flat data directly
    const secondCallArgs = (page.evaluate as jest.Mock).mock.calls[1];
    expect(secondCallArgs[1]).toEqual({ theme: 'dark', lang: 'en' });
  });

  // ─── save: captures origin-scoped format ──────────────────────────────────

  test('save captures origin along with localStorage — produces origin-scoped format', async () => {
    const localStorageItems = { theme: 'dark', user: 'alice' };
    // First evaluate call returns origin, second returns the localStorage items
    const page = makeMockPageMultiEval(['https://example.com', localStorageItems]);
    const cdpClient = makeMockCdpClient({ cookies: [] });

    await manager.save(page as unknown as Page, cdpClient, '/tmp/state.json');

    expect(mockWriteFileAtomicSafe).toHaveBeenCalledWith(
      '/tmp/state.json',
      expect.objectContaining({
        version: 1,
        localStorage: {
          'https://example.com': { theme: 'dark', user: 'alice' },
        },
      })
    );
  });

  test('save produces empty localStorage when origin is null (about:blank)', async () => {
    // about:blank returns 'null' string from window.location.origin
    const page = makeMockPageMultiEval(['null']);
    const cdpClient = makeMockCdpClient({ cookies: [] });

    await manager.save(page as unknown as Page, cdpClient, '/tmp/state.json');

    expect(mockWriteFileAtomicSafe).toHaveBeenCalledWith(
      '/tmp/state.json',
      expect.objectContaining({
        localStorage: {},
      })
    );
  });

  test('save produces empty localStorage when localStorage has no items', async () => {
    // Origin is valid but localStorage is empty
    const page = makeMockPageMultiEval(['https://example.com', {}]);
    const cdpClient = makeMockCdpClient({ cookies: [] });

    await manager.save(page as unknown as Page, cdpClient, '/tmp/state.json');

    expect(mockWriteFileAtomicSafe).toHaveBeenCalledWith(
      '/tmp/state.json',
      expect.objectContaining({
        localStorage: {},
      })
    );
  });
});
