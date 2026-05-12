/// <reference types="jest" />
/**
 * Tests for tabs_create auto-recall wiring (#824).
 *
 * Same activation matrix as navigate.auto-recall.test.ts:
 *   - flag off + arg absent → no domain_skills
 *   - flag on + matching domain → field present
 *   - flag on + unknown domain → skills === []
 *   - recall:true overrides flag-off
 *   - recall:false overrides flag-on
 */

import type { AutoRecallPayload } from '../../src/core/skill-memory/auto-recall';
import { createMockSessionManager } from '../utils/mock-session';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

jest.mock('../../src/session-manager', () => ({
  getSessionManager: jest.fn(),
}));

const mockAutoRecall = jest.fn<Promise<AutoRecallPayload>, [any]>();
jest.mock('../../src/core/skill-memory/auto-recall', () => ({
  autoRecallForOrigin: mockAutoRecall,
}));

import { getSessionManager } from '../../src/session-manager';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SESSION = 'session-auto-recall-tabs';

async function getHandler() {
  jest.resetModules();
  jest.doMock('../../src/session-manager', () => ({
    getSessionManager: () => mockSessionManager,
  }));
  jest.doMock('../../src/core/skill-memory/auto-recall', () => ({
    autoRecallForOrigin: mockAutoRecall,
  }));

  const { registerTabsCreateTool } = await import('../../src/tools/tabs-create');
  const tools = new Map<string, { handler: Function }>();
  const mockServer = {
    registerTool: (name: string, handler: unknown) => {
      tools.set(name, { handler: handler as Function });
    },
  };
  registerTabsCreateTool(mockServer as any);
  return tools.get('tabs_create')!.handler as Function;
}

let mockSessionManager: ReturnType<typeof createMockSessionManager>;

const FAKE_PAYLOAD: AutoRecallPayload = {
  skills: [{ name: 'test-skill', domain: 'example.com', body: '{}', truncated: false }],
  truncated: false,
  total_bytes: 2,
};

const EMPTY_PAYLOAD: AutoRecallPayload = { skills: [], truncated: false, total_bytes: 0 };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('tabs_create — auto-recall wiring', () => {
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
  // P2 regression: flag off + no arg → no domain_skills key at all
  // -------------------------------------------------------------------------
  test('flag off, arg absent — response has no domain_skills field', async () => {
    mockAutoRecall.mockResolvedValue(FAKE_PAYLOAD);
    const handler = await getHandler();

    const result = await handler(SESSION, { url: 'https://example.com' });
    const json = JSON.parse(result.content[0].text as string);

    expect(json).not.toHaveProperty('domain_skills');
    expect(mockAutoRecall).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Flag on + matching domain → domain_skills present
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
    mockAutoRecall.mockResolvedValue(FAKE_PAYLOAD);
    const handler = await getHandler();

    const result = await handler(SESSION, { url: 'https://example.com', recall: true });
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

    const result = await handler(SESSION, { url: 'https://example.com', recall: false });
    const json = JSON.parse(result.content[0].text as string);

    expect(json).not.toHaveProperty('domain_skills');
    expect(mockAutoRecall).not.toHaveBeenCalled();
  });
});
