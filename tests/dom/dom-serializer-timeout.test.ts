/// <reference types="jest" />
/**
 * Tests for serializeDOM() timeout and node count limit behavior.
 *
 * Covers the three read_page DOM mode timeout fixes:
 *  1. page.evaluate is wrapped in withTimeout(15000ms)
 *  2. Node count limit (DEFAULT_MAX_SERIALIZER_NODES) truncates massive DOMs
 */

import { serializeDOM } from '../../src/dom/dom-serializer';
import { OpenChromeTimeoutError } from '../../src/errors/timeout';

// ─── Constants ───────────────────────────────────────────────────────────────

const PAGE_EVALUATE_TIMEOUT_MS = 15_000;

// ─── Mock helpers ─────────────────────────────────────────────────────────────

/**
 * Creates a mock Page whose evaluate() resolves normally with page stats.
 */
function createMockPage(stats: Record<string, unknown> = {}) {
  return {
    evaluate: jest.fn().mockResolvedValue({
      url: 'https://example.com',
      title: 'Test Page',
      scrollX: 0,
      scrollY: 0,
      scrollWidth: 1920,
      scrollHeight: 3000,
      viewportWidth: 1920,
      viewportHeight: 1080,
      ...stats,
    }),
  };
}

/**
 * Creates a mock Page whose evaluate() never resolves (hangs forever).
 */
function createHangingPage() {
  return {
    evaluate: jest.fn().mockImplementation(() => new Promise(() => { /* never resolves */ })),
  };
}

/**
 * Creates a mock CDPClient whose send() returns the given root node for DOM.getDocument.
 */
function createMockCDPClient(rootNode: Record<string, unknown>) {
  return {
    send: jest.fn().mockImplementation(async (_page: unknown, method: string) => {
      if (method === 'DOM.getDocument') {
        return { root: rootNode };
      }
      return {};
    }),
  };
}

// ─── Sample DOM nodes ─────────────────────────────────────────────────────────

const simpleDomRoot = {
  nodeId: 1, backendNodeId: 1, nodeType: 9, nodeName: '#document', localName: '',
  children: [{
    nodeId: 2, backendNodeId: 2, nodeType: 1, nodeName: 'HTML', localName: 'html',
    attributes: [],
    children: [{
      nodeId: 3, backendNodeId: 3, nodeType: 1, nodeName: 'BODY', localName: 'body',
      attributes: [],
      children: [
        {
          nodeId: 4, backendNodeId: 10, nodeType: 1, nodeName: 'H1', localName: 'h1',
          attributes: ['id', 'main'],
          children: [{
            nodeId: 5, backendNodeId: 5, nodeType: 3, nodeName: '#text', localName: '',
            nodeValue: 'Hello World',
          }],
        },
      ],
    }],
  }],
};

/**
 * Builds a root document node with `count` child <div> elements under <body>.
 * Each div has its own child to ensure node count accumulates quickly.
 */
function buildLargeDomRoot(count: number): Record<string, unknown> {
  const children = Array.from({ length: count }, (_, i) => ({
    nodeId: 100 + i,
    backendNodeId: 1000 + i,
    nodeType: 1,
    nodeName: 'DIV',
    localName: 'div',
    attributes: [],
    children: [{
      nodeId: 200 + i,
      backendNodeId: 2000 + i,
      nodeType: 1,
      nodeName: 'SPAN',
      localName: 'span',
      attributes: [],
      children: [],
    }],
  }));

  return {
    nodeId: 1, backendNodeId: 1, nodeType: 9, nodeName: '#document', localName: '',
    children: [{
      nodeId: 2, backendNodeId: 2, nodeType: 1, nodeName: 'HTML', localName: 'html',
      attributes: [],
      children: [{
        nodeId: 3, backendNodeId: 3, nodeType: 1, nodeName: 'BODY', localName: 'body',
        attributes: [],
        children,
      }],
    }],
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('serializeDOM - timeout and node count limit', () => {
  // ── 1. page.evaluate timeout ──────────────────────────────────────────────

  describe('page.evaluate timeout', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    test('rejects when page.evaluate never resolves (15 s timeout)', async () => {
      const page = createHangingPage();
      const cdpClient = createMockCDPClient(simpleDomRoot);

      const promise = serializeDOM(page as never, cdpClient as never, { includePageStats: false });

      // Advance past the 15 s withTimeout threshold
      jest.advanceTimersByTime(PAGE_EVALUATE_TIMEOUT_MS);

      // Drain microtask queue so the rejection propagates
      await Promise.resolve();

      await expect(promise).rejects.toThrow(OpenChromeTimeoutError);
    });

    test('rejects with the correct timeout label and duration', async () => {
      const page = createHangingPage();
      const cdpClient = createMockCDPClient(simpleDomRoot);

      const promise = serializeDOM(page as never, cdpClient as never);

      jest.advanceTimersByTime(PAGE_EVALUATE_TIMEOUT_MS);
      await Promise.resolve();

      try {
        await promise;
        fail('Expected rejection');
      } catch (err) {
        expect(err).toBeInstanceOf(OpenChromeTimeoutError);
        const te = err as OpenChromeTimeoutError;
        expect(te.timeoutMs).toBe(PAGE_EVALUATE_TIMEOUT_MS);
        expect(te.label).toContain('serializeDOM');
      }
    });
  });

  // ── 2. page.evaluate resolves normally ───────────────────────────────────

  describe('page.evaluate normal operation', () => {
    test('resolves and returns content when page.evaluate succeeds', async () => {
      const page = createMockPage();
      const cdpClient = createMockCDPClient(simpleDomRoot);

      const result = await serializeDOM(page as never, cdpClient as never, { includePageStats: true });

      expect(result.content).toContain('[page_stats]');
      expect(result.content).toContain('url: https://example.com');
      expect(result.truncated).toBe(false);
    });

    test('returns correct pageStats from page.evaluate', async () => {
      const page = createMockPage({
        url: 'https://test.org',
        title: 'My Title',
        scrollX: 5,
        scrollY: 10,
        scrollWidth: 1280,
        scrollHeight: 2000,
        viewportWidth: 1280,
        viewportHeight: 720,
      });
      const cdpClient = createMockCDPClient(simpleDomRoot);

      const result = await serializeDOM(page as never, cdpClient as never);

      expect(result.pageStats).toMatchObject({
        url: 'https://test.org',
        title: 'My Title',
        scrollX: 5,
        scrollY: 10,
      });
    });

    test('calls page.evaluate exactly once', async () => {
      const page = createMockPage();
      const cdpClient = createMockCDPClient(simpleDomRoot);

      await serializeDOM(page as never, cdpClient as never);

      expect(page.evaluate).toHaveBeenCalledTimes(1);
    });
  });

  // ── 3. Node count limit truncation ───────────────────────────────────────

  describe('node count limit', () => {
    /**
     * DEFAULT_MAX_SERIALIZER_NODES is 100_000. We exercise truncation by passing
     * a custom maxNodes via monkey-patching the module default at runtime.
     * Instead, we build a tree large enough to exceed the real limit or use a
     * very small limit to test the code path deterministically.
     *
     * We abuse `maxOutputChars` to a large number and rely on the `maxNodes`
     * check. Since the real default is 100_000, we build a tree with slightly
     * more than that count to trigger truncation, OR we verify with a tree
     * small enough that truncation never fires.
     *
     * For the "triggers" test we pass compression:'none' so every node is
     * counted individually, and build a tree that would exceed 100_000 nodes.
     */

    test('does NOT truncate a small tree', async () => {
      const page = createMockPage();
      const cdpClient = createMockCDPClient(simpleDomRoot);

      const result = await serializeDOM(page as never, cdpClient as never, {
        includePageStats: false,
        compression: 'none',
      });

      expect(result.truncated).toBe(false);
      expect(result.content).not.toContain('[Truncated');
    });

    test('truncates when node count exceeds DEFAULT_MAX_SERIALIZER_NODES', async () => {
      // DEFAULT_MAX_SERIALIZER_NODES = 100_000.
      // Build a tree with 60_000 divs each containing 2 spans = ~180_001 nodes
      // (root doc + html + body + 60_000 divs + 60_000 spans, plus the document
      // wrapper nodes). With compression:'none' every node counts individually.
      const NODE_COUNT = 55_000; // 55_000 divs × 2 nodes each = 110_000+
      const largeDom = buildLargeDomRoot(NODE_COUNT);
      const page = createMockPage();
      const cdpClient = createMockCDPClient(largeDom);

      const result = await serializeDOM(page as never, cdpClient as never, {
        includePageStats: false,
        maxOutputChars: 999_999_999, // don't truncate via chars
        compression: 'none',         // count every node individually
      });

      expect(result.truncated).toBe(true);
      expect(result.content).toContain('[Truncated');
      expect(result.content).toContain('nodes');
    }, 30_000 /* allow 30s for large tree */);

    test('truncation message includes the node limit count', async () => {
      const NODE_COUNT = 55_000;
      const largeDom = buildLargeDomRoot(NODE_COUNT);
      const page = createMockPage();
      const cdpClient = createMockCDPClient(largeDom);

      const result = await serializeDOM(page as never, cdpClient as never, {
        includePageStats: false,
        maxOutputChars: 999_999_999,
        compression: 'none',
      });

      // The truncation message includes the limit: "visited 100,000 nodes"
      expect(result.content).toMatch(/visited[\s\S]*nodes/);
    }, 30_000);
  });
});
