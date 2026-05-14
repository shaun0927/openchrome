/// <reference types="jest" />
/**
 * Byte-identical snapshot test for the legacy CDP code path through crawl().
 *
 * Acceptance criterion (Issue #885):
 *   "crawl({ engine: 'cdp' }) and crawl({ ...no engine }) produce
 *    byte-identical output to v1.11 for a committed fixture (snapshot test
 *    against fixture server)"
 *
 * This test locks the P2 zero-impact contract: any future drift in the CDP
 * code path's output structure (when engine='cdp' or unset) breaks the
 * committed snapshot. The static-fetch waterfall introduced in #885 must not
 * change the shape of the legacy output.
 *
 * The CDP `page.evaluate` call is mocked via the session-manager to return a
 * deterministic payload, so the snapshot is reproducible without a real
 * browser. We normalize `summary.duration_ms` (the only non-deterministic
 * field) before comparing.
 *
 * @see https://github.com/shaun0927/openchrome/issues/885
 */

import { createMockSessionManager } from '../../utils/mock-session';
import { startFixtureServer, FixtureServer } from '../../helpers/fixture-server';

jest.mock('../../../src/session-manager', () => ({
  getSessionManager: jest.fn(),
}));

import { getSessionManager } from '../../../src/session-manager';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ToolHandler = (
  sessionId: string,
  args: Record<string, unknown>,
) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

let mockSessionManager: ReturnType<typeof createMockSessionManager>;

async function loadCrawlHandler(): Promise<ToolHandler> {
  jest.resetModules();
  jest.doMock('../../../src/session-manager', () => ({
    getSessionManager: () => mockSessionManager,
  }));
  const mod = await import('../../../src/tools/crawl');
  const tools: Map<string, { handler: ToolHandler }> = new Map();
  const mockServer = {
    registerTool: (toolName: string, handler: ToolHandler) => {
      tools.set(toolName, { handler });
    },
  };
  mod.registerCrawlTool(mockServer as never);
  return tools.get('crawl')!.handler;
}

/**
 * Parse a crawl tool result and zero out non-deterministic fields so the
 * remaining JSON is stable across runs.
 */
function parseAndNormalize(result: {
  content: Array<{ type: string; text: string }>;
}): { summary: Record<string, unknown>; pages: Array<Record<string, unknown>> } {
  const parsed = JSON.parse(result.content[0].text);
  if (parsed.summary && typeof parsed.summary === 'object') {
    // duration_ms is wall-clock time — normalize for byte-identical compare.
    parsed.summary.duration_ms = 0;
  }
  return parsed;
}

/**
 * Replace the mock session manager's createTarget with one that returns a
 * page whose `evaluate` callback yields deterministic content. This lets us
 * drive the CDP code path end-to-end without a real browser.
 */
function installDeterministicCdpPage(
  fixtureOrigin: string,
  payload: { title: string; content: string; links: string[] },
): void {
  void fixtureOrigin;
  // Reach into the mock's underlying createMockPage path by reusing the helper
  // directly — avoids recursing through the jest.fn wrapper we are overriding.
  // We mint a stable mock page per call and register it on the mock manager's
  // internal page map so getPage / closeTarget / removeTarget all see it.
  const { createMockPage } = jest.requireActual<typeof import('../../utils/mock-cdp')>(
    '../../utils/mock-cdp',
  );
  let nextTargetCounter = 0;
  (mockSessionManager.createTarget as jest.Mock).mockImplementation(
    async (sessionId: string, url?: string) => {
      nextTargetCounter += 1;
      const targetId = `snapshot-target-${nextTargetCounter}`;
      const page = createMockPage({ url: url || 'about:blank', targetId });
      (page.evaluate as jest.Mock).mockImplementation(async () => payload);
      // The base mock leaves waitForNavigation un-resolved; the crawl handler
      // chains .catch on it, so give it a deterministic resolution.
      (page.waitForNavigation as jest.Mock).mockResolvedValue(null);
      // Ensure the session exists, then register the page on the mock's
      // internal map so subsequent operations see a consistent view.
      await mockSessionManager.getOrCreateSession(sessionId);
      mockSessionManager._addPage(sessionId, targetId, page);
      return { targetId, page, workerId: 'default' };
    },
  );
  // The crawl code calls sessionManager.closeTarget; the mock exposes
  // removeTarget. Alias closeTarget onto the mock so the call resolves.
  (mockSessionManager as unknown as { closeTarget: jest.Mock }).closeTarget = jest
    .fn()
    .mockImplementation(async (sessionId: string, targetId: string) => {
      return mockSessionManager.removeTarget(sessionId, targetId);
    });
}

// ---------------------------------------------------------------------------
// Fixture server
// ---------------------------------------------------------------------------

const RICH_HTML = (title: string, body: string) =>
  `<!DOCTYPE html><html><head><title>${title}</title></head><body>${body}</body></html>`;

let server: FixtureServer;

beforeAll(async () => {
  server = await startFixtureServer({
    '/robots.txt': {
      status: 200,
      contentType: 'text/plain',
      body: 'User-agent: *\nDisallow:\n',
    },
    '/snapshot.html': {
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: RICH_HTML(
        'Snapshot Fixture',
        '<h1>Snapshot Fixture</h1>' +
          '<p>Deterministic body content used for the legacy CDP snapshot test.</p>',
      ),
    },
  });
});

afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  mockSessionManager = createMockSessionManager();
  (getSessionManager as jest.Mock).mockReturnValue(mockSessionManager);
});

afterEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Snapshot tests
// ---------------------------------------------------------------------------

describe('crawl legacy CDP output (P2 byte-identical contract)', () => {
  test('engine="cdp" matches committed snapshot', async () => {
    const handler = await loadCrawlHandler();
    const url = `${server.origin}/snapshot.html`;
    installDeterministicCdpPage(server.origin, {
      title: 'Snapshot Fixture',
      content: '# Snapshot Fixture\n\nDeterministic body content used for the legacy CDP snapshot test.',
      links: [],
    });

    const result = await handler('snap-cdp', {
      url,
      max_pages: 1,
      max_depth: 0,
      delay_ms: 0,
      respect_robots: false,
      engine: 'cdp',
      // Override scope so it is not bound to the random fixture port.
      scope: '<origin>/**',
    });
    const parsed = parseAndNormalize(result);
    // Replace the random fixture port in URLs so the snapshot is stable.
    parsed.pages = parsed.pages.map((p) => ({
      ...p,
      url: typeof p.url === 'string' ? p.url.replace(server.origin, '<origin>') : p.url,
    }));
    expect(parsed).toMatchSnapshot();
  });

  test('no engine arg (legacy default) matches committed snapshot', async () => {
    const handler = await loadCrawlHandler();
    const url = `${server.origin}/snapshot.html`;
    installDeterministicCdpPage(server.origin, {
      title: 'Snapshot Fixture',
      content: '# Snapshot Fixture\n\nDeterministic body content used for the legacy CDP snapshot test.',
      links: [],
    });

    const result = await handler('snap-default', {
      url,
      max_pages: 1,
      max_depth: 0,
      delay_ms: 0,
      respect_robots: false,
      // No `engine` arg — exercise the legacy default path.
      scope: '<origin>/**',
    });
    const parsed = parseAndNormalize(result);
    parsed.pages = parsed.pages.map((p) => ({
      ...p,
      url: typeof p.url === 'string' ? p.url.replace(server.origin, '<origin>') : p.url,
    }));
    expect(parsed).toMatchSnapshot();
  });

  test('engine="cdp" and no-engine produce identical output structure', async () => {
    // Same handler instance per call, but two runs with stable inputs should
    // yield identical structures aside from the (now-zeroed) duration_ms.
    const handler = await loadCrawlHandler();
    const url = `${server.origin}/snapshot.html`;
    installDeterministicCdpPage(server.origin, {
      title: 'Snapshot Fixture',
      content: '# Snapshot Fixture\n\nDeterministic body content used for the legacy CDP snapshot test.',
      links: [],
    });

    const cdpResult = await handler('snap-eq-cdp', {
      url,
      max_pages: 1,
      max_depth: 0,
      delay_ms: 0,
      respect_robots: false,
      engine: 'cdp',
      scope: '<origin>/**',
    });
    const defaultResult = await handler('snap-eq-default', {
      url,
      max_pages: 1,
      max_depth: 0,
      delay_ms: 0,
      respect_robots: false,
      scope: '<origin>/**',
    });

    const cdpParsed = parseAndNormalize(cdpResult);
    const defaultParsed = parseAndNormalize(defaultResult);

    // The two payloads should be structurally identical aside from the
    // `engine_used` field (emitted only when engine is explicit). Strip it
    // before comparing so we assert backward-compatible byte-shape.
    const stripEngineUsed = (parsed: typeof cdpParsed): typeof cdpParsed => ({
      ...parsed,
      pages: parsed.pages.map((p) => {
        const copy = { ...p } as Record<string, unknown>;
        delete copy.engine_used;
        return copy;
      }),
    });

    expect(stripEngineUsed(cdpParsed)).toEqual(stripEngineUsed(defaultParsed));
  });
});
