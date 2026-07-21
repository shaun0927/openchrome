/// <reference types="jest" />
/**
 * P14 integration test — verify serializeDOM emits reload-stable refs.
 *
 * The DOM is walked twice with the same identity signature but different
 * `backendNodeId` values (simulating a page reload where CDP re-mints ids).
 * The emitted stable refs must match 1:1 by DOM position; the emitted
 * `backendNodeId`s must not. Also spot-check collision behaviour on the
 * 200-node siblings corpus.
 */

import { serializeDOM } from '../../src/dom/dom-serializer';
import { computeStableRef } from '../../src/dom/stable-ref';

function createStats() {
  return {
    url: 'https://example.com',
    title: 'T',
    scrollX: 0, scrollY: 0,
    scrollWidth: 1920, scrollHeight: 3000,
    viewportWidth: 1920, viewportHeight: 1080,
  };
}
function mockPage() {
  return { evaluate: jest.fn().mockResolvedValue(createStats()) };
}
function mockCDP(root: Record<string, unknown>) {
  return {
    send: jest.fn().mockImplementation(async (_p: unknown, method: string) => {
      if (method === 'DOM.getDocument') return { root };
      return {};
    }),
  };
}

/** Build a small realistic tree; caller supplies the backendNodeId base
 *  so we can simulate a reload where ids shift by a fixed offset. */
function makeTree(base: number) {
  return {
    nodeId: base, backendNodeId: base, nodeType: 9, nodeName: '#document', localName: '',
    children: [{
      nodeId: base + 1, backendNodeId: base + 1, nodeType: 1, nodeName: 'HTML', localName: 'html', attributes: [],
      children: [{
        nodeId: base + 2, backendNodeId: base + 2, nodeType: 1, nodeName: 'BODY', localName: 'body', attributes: [],
        children: [
          {
            nodeId: base + 3, backendNodeId: base + 3, nodeType: 1, nodeName: 'FORM', localName: 'form',
            attributes: ['id', 'login-form'],
            children: [
              {
                nodeId: base + 4, backendNodeId: base + 4, nodeType: 1, nodeName: 'INPUT', localName: 'input',
                attributes: ['type', 'email', 'name', 'email', 'aria-label', 'Email'],
              },
              {
                nodeId: base + 5, backendNodeId: base + 5, nodeType: 1, nodeName: 'INPUT', localName: 'input',
                attributes: ['type', 'password', 'name', 'password', 'aria-label', 'Password'],
              },
              {
                nodeId: base + 6, backendNodeId: base + 6, nodeType: 1, nodeName: 'BUTTON', localName: 'button',
                attributes: ['type', 'submit', 'data-testid', 'signin-btn'],
                children: [{
                  nodeId: base + 7, backendNodeId: base + 7, nodeType: 3, nodeName: '#text', localName: '',
                  nodeValue: 'Sign in',
                }],
              },
            ],
          },
        ],
      }],
    }],
  };
}

describe('P14 integration — serializeDOM stable refs', () => {
  test('stable refs survive a simulated reload (backendNodeId churn)', async () => {
    const first = await serializeDOM(mockPage() as any, mockCDP(makeTree(100)) as any);
    const second = await serializeDOM(mockPage() as any, mockCDP(makeTree(500)) as any);

    // backendNodeIds must differ (proves the "reload" was real)
    expect(first.emittedBackendNodeIds).not.toEqual(second.emittedBackendNodeIds);

    // Stable refs must be a set-equal by DOM position — we compare the
    // ordered sequence of stable ref values, since both walks visit the
    // same tree shape.
    const refsFirst = first.emittedBackendNodeIds
      .map(id => first.emittedStableRefs.get(id))
      .filter(Boolean);
    const refsSecond = second.emittedBackendNodeIds
      .map(id => second.emittedStableRefs.get(id))
      .filter(Boolean);

    expect(refsFirst.length).toBeGreaterThan(0);
    expect(refsFirst).toEqual(refsSecond);

    // Stability rate over the corpus — must be 100%.
    const stabilityRate = refsFirst.filter((r, i) => r === refsSecond[i]).length / refsFirst.length;
    expect(stabilityRate).toBe(1);
  });

  test('collision rate on 200 realistic-ish DOM signatures is bounded', () => {
    const seen = new Map<string, number>();
    // Simulate 200 nodes drawn from a few realistic classes.
    const tags = ['button', 'a', 'input', 'span', 'div', 'li'];
    const roles = ['button', 'link', 'textbox', 'menuitem', undefined];
    const names = ['Save', 'Cancel', 'Delete', 'Edit', 'Open', 'Close', 'Sign in', 'Sign up',
                   'Search', 'Menu', 'Home', 'Back', 'Next', 'Submit', 'Reset', 'Help'];
    const ancestors = [
      ['html', 'body', 'main'],
      ['html', 'body', 'nav'],
      ['html', 'body', 'form'],
      ['html', 'body', 'aside'],
      ['html', 'body', 'main', 'section'],
    ];
    for (let i = 0; i < 200; i++) {
      const hash = computeStableRef({
        tag: tags[i % tags.length],
        role: roles[i % roles.length],
        name: names[i % names.length] + ' ' + Math.floor(i / 16),
        ancestorTags: ancestors[i % ancestors.length],
        siblingIndex: i % 8,
      });
      seen.set(hash, (seen.get(hash) ?? 0) + 1);
    }
    const collisions = [...seen.values()].filter(n => n > 1).reduce((a, b) => a + (b - 1), 0);
    const rate = collisions / 200;
    // 6-hex-char SHA-256 slice = 24 bits; 200 distinct inputs → expected
    // collisions well under 1%. Assertion has generous headroom.
    expect(rate).toBeLessThan(0.02);
  });
});
