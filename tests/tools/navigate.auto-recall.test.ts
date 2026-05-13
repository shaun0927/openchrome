/// <reference types="jest" />
/**
 * Tests for navigate auto-recall wiring (#824).
 *
 * Verifies the P2 zero-impact guarantee (no domain_skills when flag off + no
 * arg) and the activation matrix for OPENCHROME_AUTO_RECALL / recall arg.
 *
 * These tests use the "new tab" code path (no tabId arg) so that the handler
 * calls sessionManager.createTarget(sessionId, url) — the mock page then
 * returns the navigated URL from page.url(), giving hostnameFromUrl a real
 * hostname to work with.
 */

import type { AutoRecallPayload } from '../../src/core/skill-memory/auto-recall';
import { createMockSessionManager } from '../utils/mock-session';

// ---------------------------------------------------------------------------
// Module mocks — declared before any imports so Jest hoists them correctly
// ---------------------------------------------------------------------------

jest.mock('../../src/session-manager', () => ({
  getSessionManager: jest.fn(),
}));

// smartGoto is used only when tabId is provided; we use the new-tab path so
// this mock is here only for completeness (navigate.ts imports it).
jest.mock('../../src/utils/smart-goto', () => ({
  smartGoto: jest.fn(async (page: any, url: string, opts: any) => {
    await page.goto(url, opts);
    return { response: null };
  }),
}));

// Mock auto-recall so tests do not touch the real filesystem.
const mockAutoRecall = jest.fn<Promise<AutoRecallPayload>, [any]>();
jest.mock('../../src/core/skill-memory/auto-recall', () => ({
  autoRecallForUrl: async (url: string, recallArg?: boolean) => {
    const enabled = recallArg === true || (recallArg !== false && process.env.OPENCHROME_AUTO_RECALL === '1');
    return enabled ? mockAutoRecall({ origin: new URL(url).hostname }) : undefined;
  },
}));

import { getSessionManager } from '../../src/session-manager';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SESSION = 'session-auto-recall-nav';

let mockSessionManager: ReturnType<typeof createMockSessionManager>;

/** Load a fresh navigate handler with the current mock wiring. */
async function getHandler() {
  jest.resetModules();
  jest.doMock('../../src/session-manager', () => ({
    getSessionManager: () => mockSessionManager,
  }));
  jest.doMock('../../src/utils/smart-goto', () => ({
    smartGoto: jest.fn(async (page: any, url: string, opts: any) => {
      await page.goto(url, opts);
      return { response: null };
    }),
  }));
  jest.doMock('../../src/core/skill-memory/auto-recall', () => ({
    autoRecallForUrl: async (url: string, recallArg?: boolean) => {
    const enabled = recallArg === true || (recallArg !== false && process.env.OPENCHROME_AUTO_RECALL === '1');
    return enabled ? mockAutoRecall({ origin: new URL(url).hostname }) : undefined;
  },
  }));

  const { registerNavigateTool } = await import('../../src/tools/navigate');
  const tools = new Map<string, { handler: Function }>();
  const mockServer = {
    registerTool: (name: string, handler: unknown) => {
      tools.set(name, { handler: handler as Function });
    },
  };
  registerNavigateTool(mockServer as any);
  return tools.get('navigate')!.handler as Function;
}

const FAKE_PAYLOAD: AutoRecallPayload = {
  skills: [{ name: 'test-skill', domain: 'example.com', body: '{}', truncated: false }],
  truncated: false,
  total_bytes: 2,
};

const EMPTY_PAYLOAD: AutoRecallPayload = { skills: [], truncated: false, total_bytes: 0 };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('navigate — auto-recall wiring', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.OPENCHROME_AUTO_RECALL;

    mockSessionManager = createMockSessionManager();
    (getSessionManager as jest.Mock).mockReturnValue(mockSessionManager);
    mockAutoRecall.mockReset();
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // P2 regression: flag off + no arg → no domain_skills key at all.
  // The response keys must match the pre-#824 baseline exactly (P2).
  // -------------------------------------------------------------------------
  test('flag off, arg absent — response has no domain_skills field', async () => {
    mockAutoRecall.mockResolvedValue(FAKE_PAYLOAD);
    const handler = await getHandler();

    // New-tab navigation: no tabId, handler calls createTarget internally.
    const result = await handler(SESSION, { url: 'https://example.com' });
    const json = JSON.parse(result.content[0].text as string);

    expect(json).not.toHaveProperty('domain_skills');
    // The auto-recall helper should not have been invoked at all.
    expect(mockAutoRecall).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Flag on + matching domain → domain_skills field present
  // -------------------------------------------------------------------------
  test('flag on + known domain — domain_skills field is present', async () => {
    process.env.OPENCHROME_AUTO_RECALL = '1';
    mockAutoRecall.mockResolvedValue(FAKE_PAYLOAD);
    const handler = await getHandler();

    const result = await handler(SESSION, { url: 'https://example.com' });
    const json = JSON.parse(result.content[0].text as string);

    expect(json).toHaveProperty('domain_skills');
    expect(json.domain_skills.skills).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Flag on + unknown domain → skills === []
  // -------------------------------------------------------------------------
  test('flag on + unknown domain — skills array is empty', async () => {
    process.env.OPENCHROME_AUTO_RECALL = '1';
    mockAutoRecall.mockResolvedValue(EMPTY_PAYLOAD);
    const handler = await getHandler();

    const result = await handler(SESSION, { url: 'https://unknown.example' });
    const json = JSON.parse(result.content[0].text as string);

    expect(json).toHaveProperty('domain_skills');
    expect(json.domain_skills.skills).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Per-call recall:true overrides flag-off
  // -------------------------------------------------------------------------
  test('recall:true overrides flag-off', async () => {
    // Flag is off (env not set).
    mockAutoRecall.mockResolvedValue(FAKE_PAYLOAD);
    const handler = await getHandler();

    const result = await handler(SESSION, {
      url: 'https://example.com',
      recall: true,
    });
    const json = JSON.parse(result.content[0].text as string);

    expect(json).toHaveProperty('domain_skills');
    expect(mockAutoRecall).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Per-call recall:false overrides flag-on
  // -------------------------------------------------------------------------
  test('recall:false overrides flag-on', async () => {
    process.env.OPENCHROME_AUTO_RECALL = '1';
    mockAutoRecall.mockResolvedValue(FAKE_PAYLOAD);
    const handler = await getHandler();

    const result = await handler(SESSION, {
      url: 'https://example.com',
      recall: false,
    });
    const json = JSON.parse(result.content[0].text as string);

    expect(json).not.toHaveProperty('domain_skills');
    expect(mockAutoRecall).not.toHaveBeenCalled();
  });
});
