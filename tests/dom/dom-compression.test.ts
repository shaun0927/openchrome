/// <reference types="jest" />

import { serializeDOM } from '../../src/dom/dom-serializer';

// ─── Mock helpers ─────────────────────────────────────────────────────────────

function createMockPage() {
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
    }),
  };
}

function createMockCDP(rootNode: Record<string, unknown>) {
  return {
    send: jest.fn().mockImplementation(async (_page: unknown, method: string) => {
      if (method === 'DOM.getDocument') {
        return { root: rootNode };
      }
      return {};
    }),
  };
}

// ─── DOM tree helpers ─────────────────────────────────────────────────────────

interface DOMNode {
  nodeId: number;
  backendNodeId: number;
  nodeType: number;
  nodeName: string;
  localName: string;
  children?: DOMNode[];
  attributes?: string[];
  nodeValue?: string;
}

let _nextId = 1000;

function makeNode(
  tag: string,
  backendNodeId: number,
  children?: DOMNode[],
  attrs?: string[],
  _text?: string,
): DOMNode {
  return {
    nodeId: ++_nextId,
    backendNodeId,
    nodeType: 1,
    nodeName: tag.toUpperCase(),
    localName: tag.toLowerCase(),
    attributes: attrs ?? [],
    children: children ?? [],
  };
}

function makeText(text: string, id: number): DOMNode {
  return {
    nodeId: ++_nextId,
    backendNodeId: id,
    nodeType: 3,
    nodeName: '#text',
    localName: '',
    nodeValue: text,
  };
}

function makeDoc(children: DOMNode[]): DOMNode {
  return {
    nodeId: 1,
    backendNodeId: 1,
    nodeType: 9,
    nodeName: '#document',
    localName: '',
    children,
  };
}

/** Wrap children in a minimal html>body scaffold */
function wrapBody(children: DOMNode[]): DOMNode {
  return makeDoc([
    makeNode('html', 2, [
      makeNode('body', 3, children),
    ]),
  ]);
}

// ─── Strategy 1: Sibling Deduplication ───────────────────────────────────────

describe('Sibling Deduplication', () => {

  test('does not collapse fewer siblings than light threshold (3 li items)', async () => {
    // SIBLING_COLLAPSE_THRESHOLD_LIGHT = 4; 3 siblings should NOT collapse
    const items = [
      makeNode('li', 101, [makeText('Item 1', 201)]),
      makeNode('li', 102, [makeText('Item 2', 202)]),
      makeNode('li', 103, [makeText('Item 3', 203)]),
    ];
    const doc = wrapBody([makeNode('ul', 10, items)]);
    const page = createMockPage();
    const cdp = createMockCDP(doc as unknown as Record<string, unknown>);

    const result = await serializeDOM(page as never, cdp as never, {
      includePageStats: false,
      compression: 'light',
    });

    // All three should appear individually
    expect(result.content).toContain('[101]<li');
    expect(result.content).toContain('[102]<li');
    expect(result.content).toContain('[103]<li');
    // No summary line
    expect(result.content).not.toMatch(/li ×\d/);
  });

  test('collapses at threshold for light mode (6 li items → ×6 summary)', async () => {
    // 6 >= SIBLING_COLLAPSE_THRESHOLD_LIGHT (4) → should collapse
    const items = Array.from({ length: 6 }, (_, i) =>
      makeNode('li', 110 + i, [makeText(`Item ${i + 1}`, 210 + i)]),
    );
    const doc = wrapBody([makeNode('ul', 11, items)]);
    const page = createMockPage();
    const cdp = createMockCDP(doc as unknown as Record<string, unknown>);

    const result = await serializeDOM(page as never, cdp as never, {
      includePageStats: false,
      compression: 'light',
    });

    // Should show a ×6 summary
    expect(result.content).toMatch(/li ×6/);
    // Summary should include "showing 3 of 6"
    expect(result.content).toContain('showing 3 of 6');
    // First 3 samples should appear
    expect(result.content).toContain('[110]<li');
    expect(result.content).toContain('[111]<li');
    expect(result.content).toContain('[112]<li');
    // Last node (115) should also appear (emitted separately after summary)
    expect(result.content).toContain('[115]<li');
  });

  test('collapses at threshold for aggressive mode (4 li items with aggressive)', async () => {
    // 4 >= SIBLING_COLLAPSE_THRESHOLD_AGGRESSIVE (3) → should collapse
    const items = Array.from({ length: 4 }, (_, i) =>
      makeNode('li', 120 + i, [makeText(`Item ${i + 1}`, 220 + i)]),
    );
    const doc = wrapBody([makeNode('ul', 12, items)]);
    const page = createMockPage();
    const cdp = createMockCDP(doc as unknown as Record<string, unknown>);

    const result = await serializeDOM(page as never, cdp as never, {
      includePageStats: false,
      compression: 'aggressive',
    });

    expect(result.content).toMatch(/li ×4/);
    expect(result.content).toContain('showing 3 of 4');
  });

  test('does NOT collapse 4 li items with light mode when below threshold (only 3)', async () => {
    // With aggressive=3 threshold, 3 items collapse. With light=4 threshold, 3 items do NOT.
    const items = Array.from({ length: 3 }, (_, i) =>
      makeNode('li', 130 + i, [makeText(`Item ${i + 1}`, 230 + i)]),
    );
    const doc = wrapBody([makeNode('ul', 13, items)]);
    const page = createMockPage();
    const cdp = createMockCDP(doc as unknown as Record<string, unknown>);

    const resultLight = await serializeDOM(page as never, cdp as never, {
      includePageStats: false,
      compression: 'light',
    });
    const resultAggressive = await serializeDOM(page as never, cdp as never, {
      includePageStats: false,
      compression: 'aggressive',
    });

    // Light: 3 < 4, no collapse
    expect(resultLight.content).not.toMatch(/li ×3/);
    expect(resultLight.content).toContain('[130]<li');
    expect(resultLight.content).toContain('[131]<li');
    expect(resultLight.content).toContain('[132]<li');

    // Aggressive: 3 >= 3, collapses
    expect(resultAggressive.content).toMatch(/li ×3/);
  });

  test('does NOT collapse with compression=none (10 li items all shown)', async () => {
    const items = Array.from({ length: 10 }, (_, i) =>
      makeNode('li', 140 + i, [makeText(`Item ${i + 1}`, 240 + i)]),
    );
    const doc = wrapBody([makeNode('ul', 14, items)]);
    const page = createMockPage();
    const cdp = createMockCDP(doc as unknown as Record<string, unknown>);

    const result = await serializeDOM(page as never, cdp as never, {
      includePageStats: false,
      compression: 'none',
    });

    // No summary line
    expect(result.content).not.toMatch(/li ×\d/);
    // All 10 nodes appear individually
    for (let i = 0; i < 10; i++) {
      expect(result.content).toContain(`[${140 + i}]<li`);
    }
  });

  test('preserves interactive siblings — group containing button is NOT collapsed', async () => {
    // 6 div siblings, but some contain button children → interactive group → no collapse
    const items = Array.from({ length: 6 }, (_, i) => {
      const btnId = 260 + i;
      return makeNode('div', 150 + i, [
        makeNode('button', btnId, [makeText(`Button ${i + 1}`, 360 + i)]),
      ]);
    });
    const doc = wrapBody([makeNode('section', 15, items)]);
    const page = createMockPage();
    const cdp = createMockCDP(doc as unknown as Record<string, unknown>);

    const result = await serializeDOM(page as never, cdp as never, {
      includePageStats: false,
      compression: 'light',
    });

    // No summary compression for interactive group
    expect(result.content).not.toMatch(/div ×6/);
    // All divs appear
    for (let i = 0; i < 6; i++) {
      expect(result.content).toContain(`[${150 + i}]<div`);
    }
  });

  test('groups only consecutive same-tag siblings — li,li,div,li,li = two separate groups', async () => {
    // Structure: li li div li li
    // The two li groups each have 2 nodes (< threshold of 4), div is 1 — all shown individually
    // But if we use aggressive (threshold=3), still 2 < 3, no collapse either way.
    // This test verifies that mixed-tag siblings break the group.
    const children = [
      makeNode('li', 161, [makeText('A', 261)]),
      makeNode('li', 162, [makeText('B', 262)]),
      makeNode('div', 163, [makeText('C', 263)]),
      makeNode('li', 164, [makeText('D', 264)]),
      makeNode('li', 165, [makeText('E', 265)]),
    ];
    const doc = wrapBody([makeNode('ul', 16, children)]);
    const page = createMockPage();
    const cdp = createMockCDP(doc as unknown as Record<string, unknown>);

    const result = await serializeDOM(page as never, cdp as never, {
      includePageStats: false,
      compression: 'aggressive',
    });

    // Each li group has only 2 items (< threshold=3), so all appear individually
    expect(result.content).toContain('[161]<li');
    expect(result.content).toContain('[162]<li');
    expect(result.content).toContain('[163]<div');
    expect(result.content).toContain('[164]<li');
    expect(result.content).toContain('[165]<li');
    // No ×N summaries since neither group hits the threshold
    expect(result.content).not.toMatch(/li ×\d/);
  });

  test('consecutive run of 5 li followed by a div then 5 more li → two groups both collapsed', async () => {
    // First 5 li = one group, then div breaks it, then 5 li = second group
    const firstGroup = Array.from({ length: 5 }, (_, i) => makeNode('li', 170 + i, [makeText(`A${i}`, 270 + i)]));
    const divider = makeNode('div', 175, [makeText('Divider', 275)]);
    const secondGroup = Array.from({ length: 5 }, (_, i) => makeNode('li', 180 + i, [makeText(`B${i}`, 280 + i)]));
    const doc = wrapBody([makeNode('ul', 17, [...firstGroup, divider, ...secondGroup])]);
    const page = createMockPage();
    const cdp = createMockCDP(doc as unknown as Record<string, unknown>);

    const result = await serializeDOM(page as never, cdp as never, {
      includePageStats: false,
      compression: 'light',
    });

    // Both li groups (5 each >= threshold 4) should be collapsed
    const matches = result.content.match(/li ×5/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBe(2);
    // The divider div should still appear
    expect(result.content).toContain('[175]<div');
  });

  test('summary line format: [firstRef-lastRef] tag ×N (showing 3 of N)', async () => {
    const items = Array.from({ length: 5 }, (_, i) => makeNode('li', 190 + i, [makeText(`Item`, 290 + i)]));
    const doc = wrapBody([makeNode('ul', 18, items)]);
    const page = createMockPage();
    const cdp = createMockCDP(doc as unknown as Record<string, unknown>);

    const result = await serializeDOM(page as never, cdp as never, {
      includePageStats: false,
      compression: 'light',
    });

    // Expect format: [190-194] li ×5 (showing 3 of 5)
    expect(result.content).toMatch(/\[190-194\] li ×5 \(showing 3 of 5\)/);
  });
});

// ─── Strategy 2: Container Collapse ──────────────────────────────────────────

describe('Container Collapse', () => {

  test('collapses single-child container chain with > notation', async () => {
    // div > div > section > button (chain of 3 containers, leaf = button)
    const btn = makeNode('button', 401, [makeText('Click me', 501)]);
    const inner = makeNode('section', 403, [btn]);
    const middle = makeNode('div', 402, [inner]);
    const outer = makeNode('div', 400, [middle]);
    const doc = wrapBody([outer]);
    const page = createMockPage();
    const cdp = createMockCDP(doc as unknown as Record<string, unknown>);

    const result = await serializeDOM(page as never, cdp as never, {
      includePageStats: false,
      compression: 'light',
    });

    // Should have chain notation with >
    expect(result.content).toContain('>');
    // The chain should include the container ids
    expect(result.content).toMatch(/\[400\]div>\[402\]div>\[403\]section>/);
    // Leaf button should appear after the chain
    expect(result.content).toContain('[401]<button');
  });

  test('does NOT collapse multi-child containers', async () => {
    // div containing both a div AND a p — not a single-child container
    const child1 = makeNode('div', 411, [makeText('A', 511)]);
    const child2 = makeNode('p', 412, [makeText('B', 512)]);
    const outer = makeNode('div', 410, [child1, child2]);
    const doc = wrapBody([outer]);
    const page = createMockPage();
    const cdp = createMockCDP(doc as unknown as Record<string, unknown>);

    const result = await serializeDOM(page as never, cdp as never, {
      includePageStats: false,
      compression: 'light',
    });

    // Outer div should appear normally (no > chain notation for it)
    expect(result.content).toContain('[410]<div');
    // Children appear separately
    expect(result.content).toContain('[411]<div');
    expect(result.content).toContain('[412]<p');
    // No chain notation involving 410
    expect(result.content).not.toMatch(/\[410\]div>/);
  });

  test('does NOT collapse container chain with compression=none', async () => {
    // Deep single-child chain: div>div>div>button
    const btn = makeNode('button', 421, [makeText('Go', 521)]);
    const d3 = makeNode('div', 423, [btn]);
    const d2 = makeNode('div', 422, [d3]);
    const d1 = makeNode('div', 420, [d2]);
    const doc = wrapBody([d1]);
    const page = createMockPage();
    const cdp = createMockCDP(doc as unknown as Record<string, unknown>);

    const result = await serializeDOM(page as never, cdp as never, {
      includePageStats: false,
      compression: 'none',
    });

    // Each div should appear on its own line, no > chain
    expect(result.content).toContain('[420]<div');
    expect(result.content).toContain('[422]<div');
    expect(result.content).toContain('[423]<div');
    expect(result.content).toContain('[421]<button');
    // No chain notation
    expect(result.content).not.toMatch(/\[420\]div>/);
  });

  test('respects MAX_CONTAINER_CHAIN (chain deeper than 8 stops collapsing at 8)', async () => {
    // Build a 10-deep single-child div chain with a leaf button
    let current: DOMNode = makeNode('button', 499, [makeText('Leaf', 599)]);
    // Build from innermost outward: nodes 430..439 (10 divs)
    for (let i = 9; i >= 0; i--) {
      current = makeNode('div', 430 + i, [current]);
    }
    const doc = wrapBody([current]);
    const page = createMockPage();
    const cdp = createMockCDP(doc as unknown as Record<string, unknown>);

    const result = await serializeDOM(page as never, cdp as never, {
      includePageStats: false,
      compression: 'light',
    });

    // There should be chain notation (collapse happened)
    expect(result.content).toContain('>');
    // The chain should start from the outermost (430)
    expect(result.content).toMatch(/\[430\]div>/);
    // The chain should NOT exceed 8 segments (MAX_CONTAINER_CHAIN = 8)
    const chainMatch = result.content.match(/(\[\d+\]\w+>)+/);
    expect(chainMatch).not.toBeNull();
    const segments = chainMatch![0].match(/\[\d+\]\w+>/g) || [];
    expect(segments.length).toBeLessThanOrEqual(8);
  });

  test('does NOT collapse interactive containers (button with span child)', async () => {
    // A <button> containing a single <span> — button is interactive, should NOT be collapsed
    const span = makeNode('span', 441, [makeText('Label', 541)]);
    const btn = makeNode('button', 440, [span]);
    const doc = wrapBody([btn]);
    const page = createMockPage();
    const cdp = createMockCDP(doc as unknown as Record<string, unknown>);

    const result = await serializeDOM(page as never, cdp as never, {
      includePageStats: false,
      compression: 'light',
    });

    // Button should appear normally, no chain collapse
    expect(result.content).toContain('[440]<button');
    expect(result.content).toContain('[441]<span');
    // No chain notation involving button id
    expect(result.content).not.toMatch(/\[440\]button>/);
  });

  test('does NOT collapse container with direct text content', async () => {
    // A div with both text content and a single element child should NOT chain-collapse
    // because getDirectTextContent returns non-empty
    const child = makeNode('button', 451, [makeText('OK', 551)]);
    const outer = makeNode('div', 450, [
      makeText('Label text', 552),
      child,
    ]);
    const doc = wrapBody([outer]);
    const page = createMockPage();
    const cdp = createMockCDP(doc as unknown as Record<string, unknown>);

    const result = await serializeDOM(page as never, cdp as never, {
      includePageStats: false,
      compression: 'light',
    });

    // Outer div should appear normally with its text content
    expect(result.content).toContain('[450]<div');
    expect(result.content).toContain('Label text');
    // No chain collapse notation
    expect(result.content).not.toMatch(/\[450\]div>/);
  });

  test('collapses chain with light compression and not with none', async () => {
    const leaf = makeNode('p', 461, [makeText('Paragraph', 561)]);
    const inner = makeNode('section', 463, [leaf]);
    const outer = makeNode('div', 460, [inner]);
    const doc = wrapBody([outer]);
    const page = createMockPage();
    const cdp = createMockCDP(doc as unknown as Record<string, unknown>);

    const resultLight = await serializeDOM(page as never, cdp as never, {
      includePageStats: false,
      compression: 'light',
    });
    const resultNone = await serializeDOM(page as never, cdp as never, {
      includePageStats: false,
      compression: 'none',
    });

    // Light: chain collapses
    expect(resultLight.content).toMatch(/\[460\]div>\[463\]section>/);
    expect(resultLight.content).toContain('[461]<p');

    // None: each element shown separately
    expect(resultNone.content).toContain('[460]<div');
    expect(resultNone.content).toContain('[463]<section');
    expect(resultNone.content).toContain('[461]<p');
    expect(resultNone.content).not.toMatch(/\[460\]div>/);
  });
});

// ─── Combined: both strategies active simultaneously ─────────────────────────

describe('Combined: sibling dedup + container collapse', () => {

  test('page with both patterns: container chain AND sibling list both compressed', async () => {
    // Structure:
    //   body
    //     div (single-child chain) > section > ul (leaf, whose children go through normal dedup)
    //     ul2 (direct body child with 6 li items — normal dedup path applies)
    //
    // Note: li items that are children of the chain-collapsed leaf are recursed
    // individually by the chain collapse code path and therefore bypass sibling
    // grouping. Only li items processed through the normal serializeNode children
    // loop benefit from sibling dedup. ul2 is a direct child of body, so its
    // li children go through the standard groupConsecutiveSiblings path.

    const liItems = Array.from({ length: 6 }, (_, i) =>
      makeNode('li', 600 + i, [makeText(`Item ${i + 1}`, 700 + i)]),
    );
    const ul2 = makeNode('ul', 580, liItems);

    // Chain: div > section > ul (leaf is a non-list element so chain can form)
    const pLeaf = makeNode('p', 582, [makeText('Paragraph', 582)]);
    const section = makeNode('section', 571, [pLeaf]);
    const chainDiv = makeNode('div', 570, [section]);

    // body has two children: chainDiv and ul2 — body is not a container tag so no chain on body
    const doc = makeDoc([
      makeNode('html', 2, [
        makeNode('body', 3, [chainDiv, ul2]),
      ]),
    ]);
    const page = createMockPage();
    const cdp = createMockCDP(doc as unknown as Record<string, unknown>);

    const result = await serializeDOM(page as never, cdp as never, {
      includePageStats: false,
      compression: 'light',
    });

    // Container collapse: div>section chain should appear
    expect(result.content).toMatch(/\[570\]div>\[571\]section>/);
    // Leaf paragraph appears after the chain
    expect(result.content).toContain('[582]<p');

    // Sibling dedup: ul2 with 6 li items → ×6 summary
    expect(result.content).toMatch(/li ×6/);
    expect(result.content).toContain('showing 3 of 6');
    // First 3 samples appear
    expect(result.content).toContain('[600]<li');
    expect(result.content).toContain('[601]<li');
    expect(result.content).toContain('[602]<li');
  });

  test('sibling dedup does not fire when compression=none even with container chains', async () => {
    const liItems = Array.from({ length: 8 }, (_, i) =>
      makeNode('li', 800 + i, [makeText(`X${i}`, 900 + i)]),
    );
    const ul = makeNode('ul', 790, liItems);
    const inner = makeNode('div', 781, [ul]);
    const outer = makeNode('div', 780, [inner]);
    const doc = wrapBody([outer]);
    const page = createMockPage();
    const cdp = createMockCDP(doc as unknown as Record<string, unknown>);

    const result = await serializeDOM(page as never, cdp as never, {
      includePageStats: false,
      compression: 'none',
    });

    // No chain collapse
    expect(result.content).not.toMatch(/\[780\]div>/);
    // No sibling dedup
    expect(result.content).not.toMatch(/li ×\d/);
    // All 8 li items present
    for (let i = 0; i < 8; i++) {
      expect(result.content).toContain(`[${800 + i}]<li`);
    }
  });
});
