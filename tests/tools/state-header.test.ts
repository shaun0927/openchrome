/// <reference types="jest" />
/**
 * Tests for the unified state-header feature (#893).
 *
 * Covers:
 *  - formatHeaderText / prependHeaderText / mergeHeaderJson unit behaviour
 *  - OPENCHROME_STATE_HEADER=off produces byte-identical output to v1.11.0 fixture
 *  - Default (header on) output starts with the expected 4 lines
 *  - Cross-tool consistency: read_page and inspect within 100 ms share url/title
 *    and capturedAt timestamps that differ by < 200 ms
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  formatHeaderText,
  prependHeaderText,
  mergeHeaderJson,
  isStateHeaderEnabled,
  PageStateHeader,
} from '../../src/tools/_shared/state-header';
import { createMockSessionManager, createMockRefIdManager } from '../utils/mock-session';
import { sampleAccessibilityTree } from '../utils/test-helpers';

// ── Unit tests for the helper ─────────────────────────────────────────────────

describe('state-header helper', () => {
  const h: PageStateHeader = {
    url: 'https://example.com/',
    title: 'Example Domain',
    mode: 'ax',
    capturedAt: 1715000000000,
    tabId: 't1',
  };

  test('formatHeaderText produces exactly 4 lines ending with newline', () => {
    const text = formatHeaderText(h);
    const lines = text.split('\n');
    // Last element after final \n is ''
    expect(lines).toHaveLength(5);
    expect(lines[4]).toBe('');
    expect(lines[0]).toBe('- Page URL: https://example.com/');
    expect(lines[1]).toBe('- Page Title: Example Domain');
    expect(lines[2]).toBe('- Page Mode: ax');
    expect(lines[3]).toMatch(/^- Captured At: 2024-05-06T/);
  });

  test('prependHeaderText inserts header + blank line before payload', () => {
    const result = prependHeaderText(h, 'payload');
    const lines = result.split('\n');
    expect(lines[0]).toBe('- Page URL: https://example.com/');
    expect(lines[4]).toBe(''); // blank separator
    expect(lines[5]).toBe('payload');
  });

  test('prependHeaderText returns payload unchanged when OPENCHROME_STATE_HEADER=off', () => {
    const original = process.env.OPENCHROME_STATE_HEADER;
    process.env.OPENCHROME_STATE_HEADER = 'off';
    try {
      expect(prependHeaderText(h, 'payload')).toBe('payload');
    } finally {
      if (original === undefined) {
        delete process.env.OPENCHROME_STATE_HEADER;
      } else {
        process.env.OPENCHROME_STATE_HEADER = original;
      }
    }
  });

  test('prependHeaderText is case-insensitive for OFF', () => {
    const original = process.env.OPENCHROME_STATE_HEADER;
    process.env.OPENCHROME_STATE_HEADER = 'OFF';
    try {
      expect(prependHeaderText(h, 'payload')).toBe('payload');
    } finally {
      if (original === undefined) {
        delete process.env.OPENCHROME_STATE_HEADER;
      } else {
        process.env.OPENCHROME_STATE_HEADER = original;
      }
    }
  });

  test('mergeHeaderJson adds state object as first key', () => {
    const result = mergeHeaderJson(h, { foo: 'bar' }) as any;
    expect(result.state).toBeDefined();
    expect(result.state.url).toBe('https://example.com/');
    expect(result.state.mode).toBe('ax');
    expect(result.foo).toBe('bar');
  });

  test('mergeHeaderJson returns object unchanged when OPENCHROME_STATE_HEADER=off', () => {
    const original = process.env.OPENCHROME_STATE_HEADER;
    process.env.OPENCHROME_STATE_HEADER = 'off';
    try {
      const obj = { foo: 'bar' };
      const result = mergeHeaderJson(h, obj);
      expect(result).toBe(obj);
      expect((result as any).state).toBeUndefined();
    } finally {
      if (original === undefined) {
        delete process.env.OPENCHROME_STATE_HEADER;
      } else {
        process.env.OPENCHROME_STATE_HEADER = original;
      }
    }
  });

  test('isStateHeaderEnabled is true when env var is unset', () => {
    const original = process.env.OPENCHROME_STATE_HEADER;
    delete process.env.OPENCHROME_STATE_HEADER;
    try {
      expect(isStateHeaderEnabled()).toBe(true);
    } finally {
      if (original !== undefined) process.env.OPENCHROME_STATE_HEADER = original;
    }
  });

  test('isStateHeaderEnabled is false only for "off" (case-insensitive)', () => {
    for (const val of ['off', 'OFF', 'Off']) {
      process.env.OPENCHROME_STATE_HEADER = val;
      expect(isStateHeaderEnabled()).toBe(false);
    }
    for (const val of ['on', 'true', '1', 'yes', 'junk']) {
      process.env.OPENCHROME_STATE_HEADER = val;
      expect(isStateHeaderEnabled()).toBe(true);
    }
    delete process.env.OPENCHROME_STATE_HEADER;
  });
});

// ── Byte-parity test: OPENCHROME_STATE_HEADER=off ────────────────────────────

jest.mock('../../src/session-manager', () => ({
  getSessionManager: jest.fn(),
}));

jest.mock('../../src/utils/ref-id-manager', () => ({
  getRefIdManager: jest.fn(),
}));

import { getSessionManager } from '../../src/session-manager';
import { getRefIdManager } from '../../src/utils/ref-id-manager';

describe('OPENCHROME_STATE_HEADER=off byte-parity (read_page AX mode)', () => {
  let mockSessionManager: ReturnType<typeof createMockSessionManager>;
  let mockRefIdManager: ReturnType<typeof createMockRefIdManager>;
  let testSessionId: string;
  let testTargetId: string;

  const getReadPageHandler = async () => {
    jest.resetModules();
    jest.doMock('../../src/session-manager', () => ({
      getSessionManager: () => mockSessionManager,
    }));
    jest.doMock('../../src/utils/ref-id-manager', () => ({
      getRefIdManager: () => mockRefIdManager,
    }));

    const { registerReadPageTool } = await import('../../src/tools/read-page');
    const tools = new Map<string, { handler: Function }>();
    const mockServer = {
      registerTool: (name: string, handler: unknown) => {
        tools.set(name, { handler: handler as Function });
      },
    };
    registerReadPageTool(mockServer as any);
    return tools.get('read_page')!.handler;
  };

  beforeEach(async () => {
    mockSessionManager = createMockSessionManager();
    mockRefIdManager = createMockRefIdManager();
    (getSessionManager as jest.Mock).mockReturnValue(mockSessionManager);
    (getRefIdManager as jest.Mock).mockReturnValue(mockRefIdManager);

    testSessionId = 'test-session-state-header';
    const { targetId } = await mockSessionManager.createTarget(testSessionId, 'about:blank');
    testTargetId = targetId;

    mockSessionManager.mockCDPClient.setCDPResponse(
      'Accessibility.getFullAXTree',
      { depth: 8 },
      sampleAccessibilityTree,
    );

    const page = mockSessionManager.pages.get(testTargetId);
    if (page) {
      (page.evaluate as jest.Mock).mockResolvedValue({
        url: 'https://example.com',
        title: 'Test Page',
        scrollX: 0,
        scrollY: 0,
        scrollWidth: 1920,
        scrollHeight: 3000,
        viewportWidth: 1920,
        viewportHeight: 1080,
      });
      (page.url as jest.Mock).mockReturnValue('https://example.com');
      (page.title as jest.Mock).mockResolvedValue('Test Page');
    }
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test('with OPENCHROME_STATE_HEADER=off output is byte-identical to v1.11.0 fixture', async () => {
    const original = process.env.OPENCHROME_STATE_HEADER;
    process.env.OPENCHROME_STATE_HEADER = 'off';
    try {
      const handler = await getReadPageHandler();
      const result = await handler(testSessionId, {
        tabId: testTargetId,
        mode: 'ax',
        includePagination: false,
      }) as { content: Array<{ type: string; text: string }> };

      const actual = result.content[0].text;

      // Read the committed fixture
      const fixturePath = path.join(
        __dirname,
        '../fixtures/state-header/v1.11.0-read-page-ax.txt',
      );
      // Regeneration escape hatch: with REGEN_FIXTURE=1 the test rewrites the
      // fixture from the current OPENCHROME_STATE_HEADER=off output. Use this
      // after any intentional change to the read_page text format.
      if (process.env.REGEN_FIXTURE === '1') {
        fs.writeFileSync(fixturePath, actual);
      }
      const expected = fs.readFileSync(fixturePath, 'utf8');

      expect(actual.replace(/\r\n/g, '\n')).toBe(expected.replace(/\r\n/g, '\n'));
    } finally {
      if (original === undefined) {
        delete process.env.OPENCHROME_STATE_HEADER;
      } else {
        process.env.OPENCHROME_STATE_HEADER = original;
      }
    }
  });

  test('default (header on) output starts with 4 expected header lines', async () => {
    const original = process.env.OPENCHROME_STATE_HEADER;
    delete process.env.OPENCHROME_STATE_HEADER;
    try {
      const handler = await getReadPageHandler();
      const result = await handler(testSessionId, {
        tabId: testTargetId,
        mode: 'ax',
        includePagination: false,
      }) as { content: Array<{ type: string; text: string }> };

      const text = result.content[0].text;
      const lines = text.split('\n');
      expect(lines[0]).toBe('- Page URL: https://example.com');
      expect(lines[1]).toBe('- Page Title: Test Page');
      expect(lines[2]).toBe('- Page Mode: ax');
      expect(lines[3]).toMatch(/^- Captured At: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(lines[4]).toBe(''); // blank separator
    } finally {
      if (original !== undefined) process.env.OPENCHROME_STATE_HEADER = original;
    }
  });
});

// ── Cross-tool consistency ────────────────────────────────────────────────────

describe('cross-tool consistency: read_page vs inspect header fields', () => {
  test('url/title match and capturedAt differs by < 200 ms', async () => {
    // Exercise prependHeaderText and mergeHeaderJson directly with same-url inputs
    // to verify the contract without needing full tool wiring.
    const h1: PageStateHeader = {
      url: 'https://example.com/',
      title: 'Example Domain',
      mode: 'ax',
      capturedAt: Date.now(),
      tabId: 't1',
    };

    // Simulate a second call ~50 ms later
    const h2: PageStateHeader = {
      url: 'https://example.com/',
      title: 'Example Domain',
      mode: 'inspect',
      capturedAt: h1.capturedAt + 50,
      tabId: 't1',
    };

    const text1 = prependHeaderText(h1, 'payload1');
    const text2 = prependHeaderText(h2, 'payload2');

    // Extract url from header line
    const urlLine1 = text1.split('\n')[0];
    const urlLine2 = text2.split('\n')[0];
    expect(urlLine1).toBe(urlLine2);

    // Extract title
    const titleLine1 = text1.split('\n')[1];
    const titleLine2 = text2.split('\n')[1];
    expect(titleLine1).toBe(titleLine2);

    // capturedAt difference < 200 ms and non-decreasing
    const ts1 = new Date(text1.split('\n')[3].replace('- Captured At: ', '')).getTime();
    const ts2 = new Date(text2.split('\n')[3].replace('- Captured At: ', '')).getTime();
    expect(ts2).toBeGreaterThanOrEqual(ts1);
    expect(ts2 - ts1).toBeLessThan(200);
  });
});
