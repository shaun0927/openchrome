/// <reference types="jest" />

import { serializeDOM } from '../../src/dom/dom-serializer';

// ─── Mock helpers ────────────────────────────────────────────────────────────

function createMockPageForDOM(stats: Record<string, unknown> = {}) {
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

function createMockCDPClientForDOM(rootNode: Record<string, unknown>) {
  return {
    send: jest.fn().mockImplementation(async (_page: unknown, method: string) => {
      if (method === 'DOM.getDocument') {
        return { root: rootNode };
      }
      return {};
    }),
  };
}

// ─── Sample shadow DOM trees ─────────────────────────────────────────────────

/**
 * A document with a div host element that has an open shadow root containing
 * a button with text content.
 */
const openShadowDoc = {
  nodeId: 1, backendNodeId: 1, nodeType: 9, nodeName: '#document', localName: '',
  children: [{
    nodeId: 2, backendNodeId: 2, nodeType: 1, nodeName: 'HTML', localName: 'html',
    attributes: [],
    children: [{
      nodeId: 3, backendNodeId: 3, nodeType: 1, nodeName: 'BODY', localName: 'body',
      attributes: [],
      children: [{
        nodeId: 10, backendNodeId: 10, nodeType: 1, nodeName: 'DIV', localName: 'div',
        attributes: ['id', 'host'],
        shadowRoots: [{
          nodeId: 20, backendNodeId: 20, nodeType: 11, nodeName: '#document-fragment',
          localName: '', shadowRootType: 'open',
          children: [{
            nodeId: 21, backendNodeId: 2100, nodeType: 1, nodeName: 'BUTTON', localName: 'button',
            attributes: [],
            children: [{
              nodeId: 22, backendNodeId: 22, nodeType: 3, nodeName: '#text', localName: '',
              nodeValue: 'Shadow Button',
            }],
          }],
        }],
        children: [],
      }],
    }],
  }],
};

/**
 * A document with a div host that has a closed shadow root.
 */
const closedShadowDoc = {
  nodeId: 1, backendNodeId: 1, nodeType: 9, nodeName: '#document', localName: '',
  children: [{
    nodeId: 2, backendNodeId: 2, nodeType: 1, nodeName: 'HTML', localName: 'html',
    attributes: [],
    children: [{
      nodeId: 3, backendNodeId: 3, nodeType: 1, nodeName: 'BODY', localName: 'body',
      attributes: [],
      children: [{
        nodeId: 10, backendNodeId: 10, nodeType: 1, nodeName: 'DIV', localName: 'div',
        attributes: ['id', 'closed-host'],
        shadowRoots: [{
          nodeId: 20, backendNodeId: 20, nodeType: 11, nodeName: '#document-fragment',
          localName: '', shadowRootType: 'closed',
          children: [{
            nodeId: 21, backendNodeId: 2101, nodeType: 1, nodeName: 'SPAN', localName: 'span',
            attributes: ['class', 'shadow-span'],
            children: [],
          }],
        }],
        children: [],
      }],
    }],
  }],
};

/**
 * A document with a div host that has a user-agent shadow root.
 */
const userAgentShadowDoc = {
  nodeId: 1, backendNodeId: 1, nodeType: 9, nodeName: '#document', localName: '',
  children: [{
    nodeId: 2, backendNodeId: 2, nodeType: 1, nodeName: 'HTML', localName: 'html',
    attributes: [],
    children: [{
      nodeId: 3, backendNodeId: 3, nodeType: 1, nodeName: 'BODY', localName: 'body',
      attributes: [],
      children: [{
        nodeId: 10, backendNodeId: 10, nodeType: 1, nodeName: 'INPUT', localName: 'input',
        attributes: ['type', 'range'],
        shadowRoots: [{
          nodeId: 20, backendNodeId: 20, nodeType: 11, nodeName: '#document-fragment',
          localName: '', shadowRootType: 'user-agent',
          children: [{
            nodeId: 21, backendNodeId: 2102, nodeType: 1, nodeName: 'DIV', localName: 'div',
            attributes: ['id', 'ua-inner'],
            children: [],
          }],
        }],
        children: [],
      }],
    }],
  }],
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('DOM Serializer - Shadow DOM', () => {

  // 1. Open shadow root rendering
  test('renders open shadow root with correct separator and child elements', async () => {
    const page = createMockPageForDOM();
    const cdpClient = createMockCDPClientForDOM(openShadowDoc);

    const result = await serializeDOM(page as never, cdpClient as never, { includePageStats: false });

    expect(result.content).toContain('--shadow-root-- (open)');
    expect(result.content).toContain('[2100]<button');
    expect(result.content).toContain('Shadow Button');
  });

  test('open shadow root separator uses depth+1 indent (host at depth 2 → separator at 6 spaces)', async () => {
    const page = createMockPageForDOM();
    const cdpClient = createMockCDPClientForDOM(openShadowDoc);

    const result = await serializeDOM(page as never, cdpClient as never, { includePageStats: false });

    const lines = result.content.split('\n');
    // host div is at depth 2 (html=0, body=1, div=2) → separator at depth 3 = 6 spaces
    const separatorLine = lines.find(l => l.includes('--shadow-root-- (open)'));
    expect(separatorLine).toBeDefined();
    expect(separatorLine!.startsWith('      --shadow-root-- (open)')).toBe(true);
  });

  test('open shadow root children render at depth+2 (host at depth 2 → children at 8 spaces)', async () => {
    const page = createMockPageForDOM();
    const cdpClient = createMockCDPClientForDOM(openShadowDoc);

    const result = await serializeDOM(page as never, cdpClient as never, { includePageStats: false });

    const lines = result.content.split('\n');
    // shadow children at depth+2 = depth 4 = 8 spaces
    const buttonLine = lines.find(l => l.includes('[2100]<button'));
    expect(buttonLine).toBeDefined();
    expect(buttonLine!.startsWith('        [2100]<button')).toBe(true);
  });

  // 2. Closed shadow root rendering
  test('renders closed shadow root with correct separator and child elements', async () => {
    const page = createMockPageForDOM();
    const cdpClient = createMockCDPClientForDOM(closedShadowDoc);

    const result = await serializeDOM(page as never, cdpClient as never, { includePageStats: false });

    expect(result.content).toContain('--shadow-root-- (closed)');
    expect(result.content).toContain('[2101]<span');
  });

  test('closed shadow root separator uses correct indentation', async () => {
    const page = createMockPageForDOM();
    const cdpClient = createMockCDPClientForDOM(closedShadowDoc);

    const result = await serializeDOM(page as never, cdpClient as never, { includePageStats: false });

    const lines = result.content.split('\n');
    const separatorLine = lines.find(l => l.includes('--shadow-root-- (closed)'));
    expect(separatorLine).toBeDefined();
    // host div at depth 2, separator at depth 3 = 6 spaces
    expect(separatorLine!.startsWith('      --shadow-root-- (closed)')).toBe(true);
  });

  // 3. User-agent shadow root excluded by default
  test('excludes user-agent shadow root by default', async () => {
    const page = createMockPageForDOM();
    const cdpClient = createMockCDPClientForDOM(userAgentShadowDoc);

    const result = await serializeDOM(page as never, cdpClient as never, { includePageStats: false });

    expect(result.content).not.toContain('--shadow-root-- (user-agent)');
    expect(result.content).not.toContain('[2102]');
    expect(result.content).not.toContain('ua-inner');
  });

  test('excludes user-agent shadow root when includeUserAgentShadowDOM is false explicitly', async () => {
    const page = createMockPageForDOM();
    const cdpClient = createMockCDPClientForDOM(userAgentShadowDoc);

    const result = await serializeDOM(page as never, cdpClient as never, {
      includePageStats: false,
      includeUserAgentShadowDOM: false,
    });

    expect(result.content).not.toContain('--shadow-root-- (user-agent)');
    expect(result.content).not.toContain('[2102]');
  });

  // 4. User-agent shadow root included when enabled
  test('includes user-agent shadow root when includeUserAgentShadowDOM is true', async () => {
    const page = createMockPageForDOM();
    const cdpClient = createMockCDPClientForDOM(userAgentShadowDoc);

    const result = await serializeDOM(page as never, cdpClient as never, {
      includePageStats: false,
      includeUserAgentShadowDOM: true,
    });

    expect(result.content).toContain('--shadow-root-- (user-agent)');
    expect(result.content).toContain('[2102]<div');
  });

  // 5. Nested shadow roots
  test('renders nested shadow roots with both shadow boundaries', async () => {
    const nestedShadowDoc = {
      nodeId: 1, backendNodeId: 1, nodeType: 9, nodeName: '#document', localName: '',
      children: [{
        nodeId: 2, backendNodeId: 2, nodeType: 1, nodeName: 'BODY', localName: 'body',
        attributes: [],
        children: [{
          // outer host at depth 1
          nodeId: 10, backendNodeId: 1000, nodeType: 1, nodeName: 'DIV', localName: 'div',
          attributes: ['id', 'outer-host'],
          shadowRoots: [{
            nodeId: 20, backendNodeId: 20, nodeType: 11, nodeName: '#document-fragment',
            localName: '', shadowRootType: 'open',
            children: [{
              // inner host inside outer shadow root, at depth 3 (depth+2 from outer host at 1)
              nodeId: 30, backendNodeId: 3000, nodeType: 1, nodeName: 'DIV', localName: 'div',
              attributes: ['id', 'inner-host'],
              shadowRoots: [{
                nodeId: 40, backendNodeId: 40, nodeType: 11, nodeName: '#document-fragment',
                localName: '', shadowRootType: 'open',
                children: [{
                  nodeId: 50, backendNodeId: 5000, nodeType: 1, nodeName: 'SPAN', localName: 'span',
                  attributes: ['id', 'deep-element'],
                  children: [],
                }],
              }],
              children: [],
            }],
          }],
          children: [],
        }],
      }],
    };

    const page = createMockPageForDOM();
    const cdpClient = createMockCDPClientForDOM(nestedShadowDoc);

    const result = await serializeDOM(page as never, cdpClient as never, { includePageStats: false });

    // Both shadow boundaries should appear
    const separatorLines = result.content.split('\n').filter(l => l.includes('--shadow-root-- (open)'));
    expect(separatorLines).toHaveLength(2);

    // The nested shadow element should appear
    expect(result.content).toContain('[5000]<span');
    expect(result.content).toContain('id="deep-element"');

    // Outer host, inner host, and deep element should all appear
    expect(result.content).toContain('[1000]<div');
    expect(result.content).toContain('[3000]<div');
    expect(result.content).toContain('[5000]<span');
  });

  // 6. Shadow root elements have backendNodeId
  test('shadow root child elements display backendNodeId', async () => {
    const page = createMockPageForDOM();
    const cdpClient = createMockCDPClientForDOM(openShadowDoc);

    const result = await serializeDOM(page as never, cdpClient as never, { includePageStats: false });

    // backendNodeId 2100 is the button inside the shadow root
    expect(result.content).toContain('[2100]<button');
    // should not use nodeId (21) as identifier
    const lines = result.content.split('\n').filter(l => l.includes('<button'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[2100]');
    expect(lines[0]).not.toMatch(/\[21\]<button/);
  });

  // 7. Depth limiting across shadow root boundaries
  test('maxDepth limits exclude shadow root content when host is at or beyond limit', async () => {
    // host div at depth 2 (html=0, body=1, div=2)
    // shadow separator would be at depth+1=3, children at depth+2=4
    // with maxDepth=2, depth 3+ are excluded
    const page = createMockPageForDOM();
    const cdpClient = createMockCDPClientForDOM(openShadowDoc);

    const result = await serializeDOM(page as never, cdpClient as never, {
      includePageStats: false,
      maxDepth: 2,
    });

    // host element at depth 2 should be visible
    expect(result.content).toContain('[10]<div');
    // shadow content would be at depth 3+ and should not appear
    // (shadow separator is at depth+1=3, children at depth+2=4)
    // NOTE: shadow roots are processed before depth check on children,
    // but separator rendering itself checks depth; host is at depth 2 <= maxDepth=2
    // so shadow root processing happens, separator written at depth+1=3 (indentation only, not a depth-limited node)
    // The children of the shadow root are at depth+2=4, which exceeds maxDepth=2, so they are excluded
    expect(result.content).not.toContain('[2100]<button');
  });

  test('maxDepth=1 cuts off host element itself when it is too deep', async () => {
    // host div at depth 2 with maxDepth=1: host itself is excluded (depth 2 > maxDepth 1)
    const page = createMockPageForDOM();
    const cdpClient = createMockCDPClientForDOM(openShadowDoc);

    const result = await serializeDOM(page as never, cdpClient as never, {
      includePageStats: false,
      maxDepth: 1,
    });

    // host at depth 2 should NOT appear (exceeds maxDepth=1)
    expect(result.content).not.toContain('[10]<div');
    // shadow content should also not appear
    expect(result.content).not.toContain('--shadow-root--');
    expect(result.content).not.toContain('[2100]');
  });

  // 8. Interactive-only filter inside shadow roots
  test('interactive-only filter shows button inside shadow root', async () => {
    const page = createMockPageForDOM();
    const cdpClient = createMockCDPClientForDOM(openShadowDoc);

    const result = await serializeDOM(page as never, cdpClient as never, {
      includePageStats: false,
      interactiveOnly: true,
    });

    // button is interactive, should appear
    expect(result.content).toContain('[2100]<button');
  });

  test('interactive-only filter excludes non-interactive div inside shadow root', async () => {
    const mixedShadowDoc = {
      nodeId: 1, backendNodeId: 1, nodeType: 9, nodeName: '#document', localName: '',
      children: [{
        nodeId: 2, backendNodeId: 2, nodeType: 1, nodeName: 'BODY', localName: 'body',
        attributes: [],
        children: [{
          nodeId: 10, backendNodeId: 10, nodeType: 1, nodeName: 'DIV', localName: 'div',
          attributes: ['id', 'host'],
          shadowRoots: [{
            nodeId: 20, backendNodeId: 20, nodeType: 11, nodeName: '#document-fragment',
            localName: '', shadowRootType: 'open',
            children: [
              {
                nodeId: 21, backendNodeId: 2110, nodeType: 1, nodeName: 'DIV', localName: 'div',
                attributes: ['class', 'shadow-wrapper'],
                children: [],
              },
              {
                nodeId: 22, backendNodeId: 2111, nodeType: 1, nodeName: 'BUTTON', localName: 'button',
                attributes: [],
                children: [],
              },
            ],
          }],
          children: [],
        }],
      }],
    };

    const page = createMockPageForDOM();
    const cdpClient = createMockCDPClientForDOM(mixedShadowDoc);

    const result = await serializeDOM(page as never, cdpClient as never, {
      includePageStats: false,
      interactiveOnly: true,
    });

    // non-interactive div inside shadow root should be filtered out
    expect(result.content).not.toContain('[2110]');
    // interactive button inside shadow root should appear
    expect(result.content).toContain('[2111]<button');
  });

  // 9. Mixed page: light DOM + shadow DOM
  test('renders both light DOM and shadow DOM elements with correct structure', async () => {
    const mixedPageDoc = {
      nodeId: 1, backendNodeId: 1, nodeType: 9, nodeName: '#document', localName: '',
      children: [{
        nodeId: 2, backendNodeId: 2, nodeType: 1, nodeName: 'HTML', localName: 'html',
        attributes: [],
        children: [{
          nodeId: 3, backendNodeId: 3, nodeType: 1, nodeName: 'BODY', localName: 'body',
          attributes: [],
          children: [
            {
              // Light DOM element
              nodeId: 10, backendNodeId: 3100, nodeType: 1, nodeName: 'P', localName: 'p',
              attributes: ['id', 'light-para'],
              children: [{
                nodeId: 11, backendNodeId: 11, nodeType: 3, nodeName: '#text', localName: '',
                nodeValue: 'Light DOM text',
              }],
            },
            {
              // Shadow host element
              nodeId: 20, backendNodeId: 3200, nodeType: 1, nodeName: 'DIV', localName: 'div',
              attributes: ['id', 'shadow-host'],
              shadowRoots: [{
                nodeId: 30, backendNodeId: 30, nodeType: 11, nodeName: '#document-fragment',
                localName: '', shadowRootType: 'open',
                children: [{
                  nodeId: 31, backendNodeId: 3210, nodeType: 1, nodeName: 'SPAN', localName: 'span',
                  attributes: ['id', 'shadow-child'],
                  children: [],
                }],
              }],
              children: [],
            },
            {
              // Another light DOM element after shadow host
              nodeId: 40, backendNodeId: 3300, nodeType: 1, nodeName: 'BUTTON', localName: 'button',
              attributes: ['id', 'light-button'],
              children: [],
            },
          ],
        }],
      }],
    };

    const page = createMockPageForDOM();
    const cdpClient = createMockCDPClientForDOM(mixedPageDoc);

    const result = await serializeDOM(page as never, cdpClient as never, { includePageStats: false });

    // Light DOM elements appear
    expect(result.content).toContain('[3100]<p');
    expect(result.content).toContain('Light DOM text');
    expect(result.content).toContain('[3300]<button');

    // Shadow DOM elements appear
    expect(result.content).toContain('[3200]<div');
    expect(result.content).toContain('--shadow-root-- (open)');
    expect(result.content).toContain('[3210]<span');

    // Shadow content comes before light DOM siblings (shadow roots processed before children)
    const shadowSepIdx = result.content.indexOf('--shadow-root-- (open)');
    const lightButtonIdx = result.content.indexOf('[3300]<button');
    expect(shadowSepIdx).toBeLessThan(lightButtonIdx);
  });

  // 10. Shadow root with text content
  test('text nodes inside shadow root elements render correctly', async () => {
    const page = createMockPageForDOM();
    const cdpClient = createMockCDPClientForDOM(openShadowDoc);

    const result = await serializeDOM(page as never, cdpClient as never, { includePageStats: false });

    // The button's text child should appear inline with the button
    expect(result.content).toContain('[2100]<button/>Shadow Button');
  });

  test('shadow root element with multiple text children joins them', async () => {
    const multiTextShadowDoc = {
      nodeId: 1, backendNodeId: 1, nodeType: 9, nodeName: '#document', localName: '',
      children: [{
        nodeId: 2, backendNodeId: 2, nodeType: 1, nodeName: 'BODY', localName: 'body',
        attributes: [],
        children: [{
          nodeId: 10, backendNodeId: 10, nodeType: 1, nodeName: 'DIV', localName: 'div',
          attributes: [],
          shadowRoots: [{
            nodeId: 20, backendNodeId: 20, nodeType: 11, nodeName: '#document-fragment',
            localName: '', shadowRootType: 'open',
            children: [{
              nodeId: 21, backendNodeId: 2120, nodeType: 1, nodeName: 'P', localName: 'p',
              attributes: [],
              children: [
                {
                  nodeId: 22, backendNodeId: 22, nodeType: 3, nodeName: '#text', localName: '',
                  nodeValue: 'Hello',
                },
                {
                  nodeId: 23, backendNodeId: 23, nodeType: 3, nodeName: '#text', localName: '',
                  nodeValue: ' World',
                },
              ],
            }],
          }],
          children: [],
        }],
      }],
    };

    const page = createMockPageForDOM();
    const cdpClient = createMockCDPClientForDOM(multiTextShadowDoc);

    const result = await serializeDOM(page as never, cdpClient as never, { includePageStats: false });

    // Both text nodes should appear joined
    const line = result.content.split('\n').find(l => l.includes('[2120]<p'));
    expect(line).toBeDefined();
    expect(line).toContain('Hello');
    expect(line).toContain('World');
  });

  // 11. Shadow root with no children
  test('handles shadow root with no children gracefully', async () => {
    const emptyRootDoc = {
      nodeId: 1, backendNodeId: 1, nodeType: 9, nodeName: '#document', localName: '',
      children: [{
        nodeId: 2, backendNodeId: 2, nodeType: 1, nodeName: 'BODY', localName: 'body',
        attributes: [],
        children: [{
          nodeId: 10, backendNodeId: 1010, nodeType: 1, nodeName: 'DIV', localName: 'div',
          attributes: ['id', 'empty-host'],
          shadowRoots: [{
            nodeId: 20, backendNodeId: 20, nodeType: 11, nodeName: '#document-fragment',
            localName: '', shadowRootType: 'open',
            // no children array
          }],
          children: [],
        }],
      }],
    };

    const page = createMockPageForDOM();
    const cdpClient = createMockCDPClientForDOM(emptyRootDoc);

    // Should not throw
    const result = await serializeDOM(page as never, cdpClient as never, { includePageStats: false });

    // Host element and separator should appear
    expect(result.content).toContain('[1010]<div');
    expect(result.content).toContain('--shadow-root-- (open)');
    expect(result.truncated).toBe(false);
  });

  // 12. Multiple shadow roots on one host
  test('renders multiple shadow roots sequentially on one host', async () => {
    const multiRootDoc = {
      nodeId: 1, backendNodeId: 1, nodeType: 9, nodeName: '#document', localName: '',
      children: [{
        nodeId: 2, backendNodeId: 2, nodeType: 1, nodeName: 'BODY', localName: 'body',
        attributes: [],
        children: [{
          nodeId: 10, backendNodeId: 10, nodeType: 1, nodeName: 'DIV', localName: 'div',
          attributes: [],
          shadowRoots: [
            {
              nodeId: 20, backendNodeId: 20, nodeType: 11, nodeName: '#document-fragment',
              localName: '', shadowRootType: 'open',
              children: [{
                nodeId: 21, backendNodeId: 2200, nodeType: 1, nodeName: 'SPAN', localName: 'span',
                attributes: ['id', 'first-shadow'],
                children: [],
              }],
            },
            {
              nodeId: 30, backendNodeId: 30, nodeType: 11, nodeName: '#document-fragment',
              localName: '', shadowRootType: 'closed',
              children: [{
                nodeId: 31, backendNodeId: 3200, nodeType: 1, nodeName: 'SPAN', localName: 'span',
                attributes: ['id', 'second-shadow'],
                children: [],
              }],
            },
          ],
          children: [],
        }],
      }],
    };

    const page = createMockPageForDOM();
    const cdpClient = createMockCDPClientForDOM(multiRootDoc);

    const result = await serializeDOM(page as never, cdpClient as never, { includePageStats: false });

    expect(result.content).toContain('--shadow-root-- (open)');
    expect(result.content).toContain('--shadow-root-- (closed)');
    expect(result.content).toContain('[2200]<span');
    expect(result.content).toContain('[3200]<span');

    // open shadow root should appear before closed
    const openIdx = result.content.indexOf('--shadow-root-- (open)');
    const closedIdx = result.content.indexOf('--shadow-root-- (closed)');
    expect(openIdx).toBeLessThan(closedIdx);
  });

  // 13. Shadow root preserves light DOM children after shadow content
  test('light DOM children of host element appear after shadow root content', async () => {
    const shadowThenLightDoc = {
      nodeId: 1, backendNodeId: 1, nodeType: 9, nodeName: '#document', localName: '',
      children: [{
        nodeId: 2, backendNodeId: 2, nodeType: 1, nodeName: 'BODY', localName: 'body',
        attributes: [],
        children: [{
          nodeId: 10, backendNodeId: 10, nodeType: 1, nodeName: 'DIV', localName: 'div',
          attributes: ['id', 'host'],
          shadowRoots: [{
            nodeId: 20, backendNodeId: 20, nodeType: 11, nodeName: '#document-fragment',
            localName: '', shadowRootType: 'open',
            children: [{
              nodeId: 21, backendNodeId: 4100, nodeType: 1, nodeName: 'SPAN', localName: 'span',
              attributes: ['id', 'shadow-content'],
              children: [],
            }],
          }],
          children: [{
            nodeId: 30, backendNodeId: 4200, nodeType: 1, nodeName: 'SLOT', localName: 'slot',
            attributes: [],
            children: [],
          }],
        }],
      }],
    };

    const page = createMockPageForDOM();
    const cdpClient = createMockCDPClientForDOM(shadowThenLightDoc);

    const result = await serializeDOM(page as never, cdpClient as never, { includePageStats: false });

    // Both shadow and light children appear
    expect(result.content).toContain('[4100]<span');
    expect(result.content).toContain('[4200]<slot');

    // Shadow root separator precedes the light DOM child slot
    const shadowIdx = result.content.indexOf('--shadow-root-- (open)');
    const slotIdx = result.content.indexOf('[4200]<slot');
    expect(shadowIdx).toBeLessThan(slotIdx);
  });

  // 14. Attribute filtering applies inside shadow roots
  test('keeps only actionable attributes for elements inside shadow roots', async () => {
    const attrShadowDoc = {
      nodeId: 1, backendNodeId: 1, nodeType: 9, nodeName: '#document', localName: '',
      children: [{
        nodeId: 2, backendNodeId: 2, nodeType: 1, nodeName: 'BODY', localName: 'body',
        attributes: [],
        children: [{
          nodeId: 10, backendNodeId: 10, nodeType: 1, nodeName: 'DIV', localName: 'div',
          attributes: [],
          shadowRoots: [{
            nodeId: 20, backendNodeId: 20, nodeType: 11, nodeName: '#document-fragment',
            localName: '', shadowRootType: 'open',
            children: [{
              nodeId: 21, backendNodeId: 4300, nodeType: 1, nodeName: 'A', localName: 'a',
              attributes: [
                'id', 'shadow-link',
                'href', '/shadow-path',
                'aria-label', 'Shadow link',
                'onclick', 'handleClick()',
                'data-custom', 'some-value',
              ],
              children: [],
            }],
          }],
          children: [],
        }],
      }],
    };

    const page = createMockPageForDOM();
    const cdpClient = createMockCDPClientForDOM(attrShadowDoc);

    const result = await serializeDOM(page as never, cdpClient as never, { includePageStats: false });

    const line = result.content.split('\n').find(l => l.includes('[4300]<a'));
    expect(line).toBeDefined();
    expect(line).toContain('id="shadow-link"');
    expect(line).toContain('href="/shadow-path"');
    expect(line).toContain('aria-label="Shadow link"');
    // filtered out
    expect(line).not.toContain('onclick');
    expect(line).not.toContain('data-custom');
  });

  // 15. Skipped tags inside shadow roots
  test('skips script and style nodes inside shadow roots', async () => {
    const noisyShadowDoc = {
      nodeId: 1, backendNodeId: 1, nodeType: 9, nodeName: '#document', localName: '',
      children: [{
        nodeId: 2, backendNodeId: 2, nodeType: 1, nodeName: 'BODY', localName: 'body',
        attributes: [],
        children: [{
          nodeId: 10, backendNodeId: 10, nodeType: 1, nodeName: 'DIV', localName: 'div',
          attributes: [],
          shadowRoots: [{
            nodeId: 20, backendNodeId: 20, nodeType: 11, nodeName: '#document-fragment',
            localName: '', shadowRootType: 'open',
            children: [
              { nodeId: 21, backendNodeId: 21, nodeType: 1, nodeName: 'SCRIPT', localName: 'script', attributes: [] },
              { nodeId: 22, backendNodeId: 22, nodeType: 1, nodeName: 'STYLE', localName: 'style', attributes: [] },
              {
                nodeId: 23, backendNodeId: 4400, nodeType: 1, nodeName: 'BUTTON', localName: 'button',
                attributes: ['id', 'shadow-btn'],
                children: [],
              },
            ],
          }],
          children: [],
        }],
      }],
    };

    const page = createMockPageForDOM();
    const cdpClient = createMockCDPClientForDOM(noisyShadowDoc);

    const result = await serializeDOM(page as never, cdpClient as never, { includePageStats: false });

    expect(result.content).not.toContain('<script');
    expect(result.content).not.toContain('<style');
    // button inside shadow root should appear
    expect(result.content).toContain('[4400]<button');
  });
});
