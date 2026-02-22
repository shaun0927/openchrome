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

// ─── Sample DOM trees ────────────────────────────────────────────────────────

const simpleDoc = {
  nodeId: 1, backendNodeId: 1, nodeType: 9, nodeName: '#document', localName: '',
  children: [{
    nodeId: 2, backendNodeId: 2, nodeType: 1, nodeName: 'HTML', localName: 'html',
    attributes: [],
    children: [{
      nodeId: 3, backendNodeId: 3, nodeType: 1, nodeName: 'BODY', localName: 'body',
      attributes: [],
      children: [
        {
          nodeId: 4, backendNodeId: 100, nodeType: 1, nodeName: 'H1', localName: 'h1',
          attributes: ['id', 'title'],
          children: [{
            nodeId: 5, backendNodeId: 5, nodeType: 3, nodeName: '#text', localName: '',
            nodeValue: 'Hello World',
          }],
        },
        {
          nodeId: 6, backendNodeId: 101, nodeType: 1, nodeName: 'P', localName: 'p',
          attributes: ['class', 'content'],
          children: [{
            nodeId: 7, backendNodeId: 7, nodeType: 3, nodeName: '#text', localName: '',
            nodeValue: 'Some text',
          }],
        },
      ],
    }],
  }],
};

const emptyDoc = {
  nodeId: 1, backendNodeId: 1, nodeType: 9, nodeName: '#document', localName: '',
  children: [],
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('DOM Serializer', () => {

  // 1. Basic serialization
  test('serializes a simple DOM tree with correct format', async () => {
    const page = createMockPageForDOM();
    const cdpClient = createMockCDPClientForDOM(simpleDoc);

    const result = await serializeDOM(page as never, cdpClient as never, { includePageStats: false });

    // backendNodeId appears, not ref_N
    expect(result.content).toContain('[100]<h1');
    expect(result.content).toContain('[101]<p');
    // text content appears after tag
    expect(result.content).toContain('Hello World');
    expect(result.content).toContain('Some text');
    // self-closing format
    expect(result.content).toMatch(/\[100\]<h1[^>]*\/>/);
  });

  test('uses 2-space indentation per depth level', async () => {
    const page = createMockPageForDOM();
    const cdpClient = createMockCDPClientForDOM(simpleDoc);

    const result = await serializeDOM(page as never, cdpClient as never, { includePageStats: false });

    const lines = result.content.split('\n').filter(Boolean);
    // html is depth 0 → no indent
    const htmlLine = lines.find(l => l.includes('<html'));
    expect(htmlLine).toBeDefined();
    expect(htmlLine!.startsWith('[2]<html')).toBe(true);

    // body is depth 1 → 2 spaces
    const bodyLine = lines.find(l => l.includes('<body'));
    expect(bodyLine).toBeDefined();
    expect(bodyLine!.startsWith('  [3]<body')).toBe(true);

    // h1 is depth 2 → 4 spaces
    const h1Line = lines.find(l => l.includes('<h1'));
    expect(h1Line).toBeDefined();
    expect(h1Line!.startsWith('    [100]<h1')).toBe(true);
  });

  // 2. Page stats header
  test('includes page_stats header by default', async () => {
    const page = createMockPageForDOM();
    const cdpClient = createMockCDPClientForDOM(simpleDoc);

    const result = await serializeDOM(page as never, cdpClient as never);

    expect(result.content).toContain('[page_stats]');
    expect(result.content).toContain('url: https://example.com');
    expect(result.content).toContain('title: Test Page');
    expect(result.content).toContain('scroll: 0,0');
    expect(result.content).toContain('viewport: 1920x1080');
  });

  test('omits page_stats when includePageStats is false', async () => {
    const page = createMockPageForDOM();
    const cdpClient = createMockCDPClientForDOM(simpleDoc);

    const result = await serializeDOM(page as never, cdpClient as never, { includePageStats: false });

    expect(result.content).not.toContain('[page_stats]');
  });

  // 3. Node filtering
  test('filters out script, style, svg, noscript, meta, link, head nodes', async () => {
    const docWithNoise = {
      nodeId: 1, backendNodeId: 1, nodeType: 9, nodeName: '#document', localName: '',
      children: [{
        nodeId: 2, backendNodeId: 2, nodeType: 1, nodeName: 'HTML', localName: 'html',
        attributes: [],
        children: [
          {
            nodeId: 10, backendNodeId: 10, nodeType: 1, nodeName: 'HEAD', localName: 'head',
            attributes: [],
            children: [
              { nodeId: 11, backendNodeId: 11, nodeType: 1, nodeName: 'META', localName: 'meta', attributes: [] },
              { nodeId: 12, backendNodeId: 12, nodeType: 1, nodeName: 'LINK', localName: 'link', attributes: [] },
            ],
          },
          {
            nodeId: 20, backendNodeId: 20, nodeType: 1, nodeName: 'BODY', localName: 'body',
            attributes: [],
            children: [
              { nodeId: 21, backendNodeId: 21, nodeType: 1, nodeName: 'SCRIPT', localName: 'script', attributes: [] },
              { nodeId: 22, backendNodeId: 22, nodeType: 1, nodeName: 'STYLE', localName: 'style', attributes: [] },
              { nodeId: 23, backendNodeId: 23, nodeType: 1, nodeName: 'SVG', localName: 'svg', attributes: [] },
              { nodeId: 24, backendNodeId: 24, nodeType: 1, nodeName: 'NOSCRIPT', localName: 'noscript', attributes: [] },
              {
                nodeId: 25, backendNodeId: 200, nodeType: 1, nodeName: 'DIV', localName: 'div',
                attributes: ['id', 'main'],
                children: [],
              },
            ],
          },
        ],
      }],
    };

    const page = createMockPageForDOM();
    const cdpClient = createMockCDPClientForDOM(docWithNoise);

    const result = await serializeDOM(page as never, cdpClient as never, { includePageStats: false });

    expect(result.content).not.toContain('<script');
    expect(result.content).not.toContain('<style');
    expect(result.content).not.toContain('<svg');
    expect(result.content).not.toContain('<noscript');
    expect(result.content).not.toContain('<meta');
    expect(result.content).not.toContain('<link');
    expect(result.content).not.toContain('<head');
    // div should survive
    expect(result.content).toContain('[200]<div');
  });

  // 4. Attribute filtering
  test('keeps only actionable attributes', async () => {
    const docWithAttrs = {
      nodeId: 1, backendNodeId: 1, nodeType: 9, nodeName: '#document', localName: '',
      children: [{
        nodeId: 2, backendNodeId: 2, nodeType: 1, nodeName: 'BODY', localName: 'body',
        attributes: [],
        children: [{
          nodeId: 3, backendNodeId: 300, nodeType: 1, nodeName: 'A', localName: 'a',
          attributes: [
            'id', 'my-id',
            'class', 'my-class',
            'onclick', 'doSomething()',
            'data-custom', 'secret',
            'aria-label', 'Click here',
            'href', '/home',
          ],
          children: [],
        }],
      }],
    };

    const page = createMockPageForDOM();
    const cdpClient = createMockCDPClientForDOM(docWithAttrs);

    const result = await serializeDOM(page as never, cdpClient as never, { includePageStats: false });

    const line = result.content.split('\n').find(l => l.includes('<a '));
    expect(line).toBeDefined();
    expect(line).toContain('id="my-id"');
    expect(line).toContain('class="my-class"');
    expect(line).toContain('aria-label="Click here"');
    expect(line).toContain('href="/home"');
    // filtered out
    expect(line).not.toContain('onclick');
    expect(line).not.toContain('data-custom');
  });

  // 5. Text content
  test('includes direct text content from text node children', async () => {
    const docWithButton = {
      nodeId: 1, backendNodeId: 1, nodeType: 9, nodeName: '#document', localName: '',
      children: [{
        nodeId: 2, backendNodeId: 2, nodeType: 1, nodeName: 'BODY', localName: 'body',
        attributes: [],
        children: [{
          nodeId: 3, backendNodeId: 400, nodeType: 1, nodeName: 'BUTTON', localName: 'button',
          attributes: [],
          children: [{
            nodeId: 4, backendNodeId: 4, nodeType: 3, nodeName: '#text', localName: '',
            nodeValue: 'Click me',
          }],
        }],
      }],
    };

    const page = createMockPageForDOM();
    const cdpClient = createMockCDPClientForDOM(docWithButton);

    const result = await serializeDOM(page as never, cdpClient as never, { includePageStats: false });

    expect(result.content).toContain('[400]<button/>Click me');
  });

  test('truncates text content longer than 200 chars', async () => {
    const longText = 'A'.repeat(300);
    const docWithLongText = {
      nodeId: 1, backendNodeId: 1, nodeType: 9, nodeName: '#document', localName: '',
      children: [{
        nodeId: 2, backendNodeId: 2, nodeType: 1, nodeName: 'BODY', localName: 'body',
        attributes: [],
        children: [{
          nodeId: 3, backendNodeId: 500, nodeType: 1, nodeName: 'P', localName: 'p',
          attributes: [],
          children: [{
            nodeId: 4, backendNodeId: 4, nodeType: 3, nodeName: '#text', localName: '',
            nodeValue: longText,
          }],
        }],
      }],
    };

    const page = createMockPageForDOM();
    const cdpClient = createMockCDPClientForDOM(docWithLongText);

    const result = await serializeDOM(page as never, cdpClient as never, { includePageStats: false });

    const line = result.content.split('\n').find(l => l.includes('[500]<p'));
    expect(line).toBeDefined();
    // text should be truncated to 200 chars — extract text after the closing />
    const closingSlash = line!.indexOf('/>');
    const textPart = line!.slice(closingSlash + 2).trimEnd();
    expect(textPart.length).toBeLessThanOrEqual(200);
  });

  // 6. Depth limiting
  test('respects maxDepth option', async () => {
    const deepDoc = {
      nodeId: 1, backendNodeId: 1, nodeType: 9, nodeName: '#document', localName: '',
      children: [{
        nodeId: 2, backendNodeId: 2, nodeType: 1, nodeName: 'HTML', localName: 'html',
        attributes: [],
        children: [{
          nodeId: 3, backendNodeId: 3, nodeType: 1, nodeName: 'BODY', localName: 'body',
          attributes: [],
          children: [{
            nodeId: 4, backendNodeId: 4, nodeType: 1, nodeName: 'DIV', localName: 'div',
            attributes: [],
            children: [{
              nodeId: 5, backendNodeId: 5, nodeType: 1, nodeName: 'DIV', localName: 'div',
              attributes: [],
              children: [{
                nodeId: 6, backendNodeId: 600, nodeType: 1, nodeName: 'SPAN', localName: 'span',
                attributes: ['id', 'deep'],
                children: [],
              }],
            }],
          }],
        }],
      }],
    };

    const page = createMockPageForDOM();
    const cdpClient = createMockCDPClientForDOM(deepDoc);

    // maxDepth=2 means depth 0,1,2 → html(0), body(1), div(2) visible; inner div(3) and span(4) not
    const result = await serializeDOM(page as never, cdpClient as never, { includePageStats: false, maxDepth: 2 });

    expect(result.content).toContain('<html');
    expect(result.content).toContain('<body');
    // First div is at depth 2 (html=0, body=1, div=2)
    expect(result.content).toContain('<div');
    // Span is at depth 4, should NOT appear
    expect(result.content).not.toContain('id="deep"');
    expect(result.content).not.toContain('[600]');
  });

  // 7. Interactive-only filter
  test('filters to interactive elements only when interactiveOnly is true', async () => {
    const mixedDoc = {
      nodeId: 1, backendNodeId: 1, nodeType: 9, nodeName: '#document', localName: '',
      children: [{
        nodeId: 2, backendNodeId: 2, nodeType: 1, nodeName: 'BODY', localName: 'body',
        attributes: [],
        children: [
          { nodeId: 3, backendNodeId: 700, nodeType: 1, nodeName: 'DIV', localName: 'div', attributes: [], children: [] },
          { nodeId: 4, backendNodeId: 701, nodeType: 1, nodeName: 'P', localName: 'p', attributes: [], children: [] },
          { nodeId: 5, backendNodeId: 702, nodeType: 1, nodeName: 'INPUT', localName: 'input', attributes: ['type', 'text'], children: [] },
          { nodeId: 6, backendNodeId: 703, nodeType: 1, nodeName: 'BUTTON', localName: 'button', attributes: [], children: [] },
          { nodeId: 7, backendNodeId: 704, nodeType: 1, nodeName: 'A', localName: 'a', attributes: ['href', '/'], children: [] },
        ],
      }],
    };

    const page = createMockPageForDOM();
    const cdpClient = createMockCDPClientForDOM(mixedDoc);

    const result = await serializeDOM(page as never, cdpClient as never, { includePageStats: false, interactiveOnly: true });

    expect(result.content).not.toContain('[700]');  // div
    expect(result.content).not.toContain('[701]');  // p
    expect(result.content).toContain('[702]');      // input
    expect(result.content).toContain('[703]');      // button
    expect(result.content).toContain('[704]');      // a
  });

  test('filters to interactive elements when filter is "interactive"', async () => {
    const mixedDoc = {
      nodeId: 1, backendNodeId: 1, nodeType: 9, nodeName: '#document', localName: '',
      children: [{
        nodeId: 2, backendNodeId: 2, nodeType: 1, nodeName: 'BODY', localName: 'body',
        attributes: [],
        children: [
          { nodeId: 3, backendNodeId: 800, nodeType: 1, nodeName: 'SPAN', localName: 'span', attributes: [], children: [] },
          { nodeId: 4, backendNodeId: 801, nodeType: 1, nodeName: 'BUTTON', localName: 'button', attributes: [], children: [] },
        ],
      }],
    };

    const page = createMockPageForDOM();
    const cdpClient = createMockCDPClientForDOM(mixedDoc);

    const result = await serializeDOM(page as never, cdpClient as never, { includePageStats: false, filter: 'interactive' });

    expect(result.content).not.toContain('[800]');  // span
    expect(result.content).toContain('[801]');      // button
  });

  test('includes role-based interactive elements', async () => {
    const roleDoc = {
      nodeId: 1, backendNodeId: 1, nodeType: 9, nodeName: '#document', localName: '',
      children: [{
        nodeId: 2, backendNodeId: 2, nodeType: 1, nodeName: 'BODY', localName: 'body',
        attributes: [],
        children: [
          {
            nodeId: 3, backendNodeId: 900, nodeType: 1, nodeName: 'DIV', localName: 'div',
            attributes: ['role', 'button'],
            children: [],
          },
          {
            nodeId: 4, backendNodeId: 901, nodeType: 1, nodeName: 'SPAN', localName: 'span',
            attributes: ['role', 'link'],
            children: [],
          },
          {
            nodeId: 5, backendNodeId: 902, nodeType: 1, nodeName: 'DIV', localName: 'div',
            attributes: ['class', 'plain'],
            children: [],
          },
        ],
      }],
    };

    const page = createMockPageForDOM();
    const cdpClient = createMockCDPClientForDOM(roleDoc);

    const result = await serializeDOM(page as never, cdpClient as never, { includePageStats: false, interactiveOnly: true });

    expect(result.content).toContain('[900]');  // div role=button
    expect(result.content).toContain('[901]');  // span role=link
    expect(result.content).not.toContain('[902]');  // plain div
  });

  // 8. Output truncation
  test('truncates output at maxOutputChars', async () => {
    // Build a large DOM with many nodes
    const manyChildren = Array.from({ length: 50 }, (_, i) => ({
      nodeId: 100 + i, backendNodeId: 1000 + i, nodeType: 1,
      nodeName: 'P', localName: 'p', attributes: ['id', `para-${i}`],
      children: [{
        nodeId: 200 + i, backendNodeId: 200 + i, nodeType: 3,
        nodeName: '#text', localName: '',
        nodeValue: 'This is a moderately long paragraph text content that takes up space.',
      }],
    }));

    const bigDoc = {
      nodeId: 1, backendNodeId: 1, nodeType: 9, nodeName: '#document', localName: '',
      children: [{
        nodeId: 2, backendNodeId: 2, nodeType: 1, nodeName: 'BODY', localName: 'body',
        attributes: [],
        children: manyChildren,
      }],
    };

    const page = createMockPageForDOM();
    const cdpClient = createMockCDPClientForDOM(bigDoc);

    const result = await serializeDOM(page as never, cdpClient as never, { includePageStats: false, maxOutputChars: 500 });

    expect(result.truncated).toBe(true);
    expect(result.content).toContain('[Output truncated at 50000 chars. Use depth parameter to limit scope.]');
  });

  test('sets truncated to false when output fits', async () => {
    const page = createMockPageForDOM();
    const cdpClient = createMockCDPClientForDOM(simpleDoc);

    const result = await serializeDOM(page as never, cdpClient as never);

    expect(result.truncated).toBe(false);
  });

  // 9. Empty/edge cases
  test('handles empty document', async () => {
    const page = createMockPageForDOM();
    const cdpClient = createMockCDPClientForDOM(emptyDoc);

    const result = await serializeDOM(page as never, cdpClient as never);

    // Should contain page_stats header but no element nodes
    expect(result.content).toContain('[page_stats]');
    expect(result.truncated).toBe(false);
    expect(result.content).not.toContain('<html');
  });

  test('handles text-only nodes (no element children)', async () => {
    const textOnlyDoc = {
      nodeId: 1, backendNodeId: 1, nodeType: 9, nodeName: '#document', localName: '',
      children: [{
        nodeId: 2, backendNodeId: 2, nodeType: 1, nodeName: 'BODY', localName: 'body',
        attributes: [],
        children: [{
          nodeId: 3, backendNodeId: 3, nodeType: 3, nodeName: '#text', localName: '',
          nodeValue: 'plain text',
        }],
      }],
    };

    const page = createMockPageForDOM();
    const cdpClient = createMockCDPClientForDOM(textOnlyDoc);

    // Should not throw
    const result = await serializeDOM(page as never, cdpClient as never, { includePageStats: false });
    // body is present (it's an element), text node is skipped at element level
    expect(result.content).toContain('<body');
    expect(result.truncated).toBe(false);
  });

  // 10. Iframe handling
  test('includes iframe content with page separator when pierceIframes is true', async () => {
    const iframeDoc = {
      nodeId: 1, backendNodeId: 1, nodeType: 9, nodeName: '#document', localName: '',
      children: [{
        nodeId: 2, backendNodeId: 2, nodeType: 1, nodeName: 'BODY', localName: 'body',
        attributes: [],
        children: [{
          nodeId: 3, backendNodeId: 1100, nodeType: 1, nodeName: 'IFRAME', localName: 'iframe',
          attributes: ['src', 'https://inner.example.com'],
          contentDocument: {
            nodeId: 10, backendNodeId: 10, nodeType: 9, nodeName: '#document', localName: '',
            children: [{
              nodeId: 11, backendNodeId: 1101, nodeType: 1, nodeName: 'P', localName: 'p',
              attributes: [],
              children: [],
            }],
          },
        }],
      }],
    };

    const page = createMockPageForDOM();
    const cdpClient = createMockCDPClientForDOM(iframeDoc);

    const result = await serializeDOM(page as never, cdpClient as never, { includePageStats: false, pierceIframes: true });

    expect(result.content).toContain('--page-separator--');
    expect(result.content).toContain('iframe: https://inner.example.com');
    expect(result.content).toContain('[1101]<p');
  });

  test('skips iframe content when pierceIframes is false', async () => {
    const iframeDoc = {
      nodeId: 1, backendNodeId: 1, nodeType: 9, nodeName: '#document', localName: '',
      children: [{
        nodeId: 2, backendNodeId: 2, nodeType: 1, nodeName: 'BODY', localName: 'body',
        attributes: [],
        children: [{
          nodeId: 3, backendNodeId: 1200, nodeType: 1, nodeName: 'IFRAME', localName: 'iframe',
          attributes: ['src', 'https://inner.example.com'],
          contentDocument: {
            nodeId: 10, backendNodeId: 10, nodeType: 9, nodeName: '#document', localName: '',
            children: [{
              nodeId: 11, backendNodeId: 1201, nodeType: 1, nodeName: 'P', localName: 'p',
              attributes: [],
              children: [],
            }],
          },
        }],
      }],
    };

    const page = createMockPageForDOM();
    const cdpClient = createMockCDPClientForDOM(iframeDoc);

    const result = await serializeDOM(page as never, cdpClient as never, { includePageStats: false, pierceIframes: false });

    expect(result.content).not.toContain('--page-separator--');
    expect(result.content).not.toContain('[1201]');
    // iframe element itself should still appear
    expect(result.content).toContain('[1200]<iframe');
  });

  // 11. Return value structure
  test('returns pageStats object with correct properties', async () => {
    const page = createMockPageForDOM({
      url: 'https://test.com/path',
      title: 'My Page',
      scrollX: 10,
      scrollY: 20,
      scrollWidth: 2560,
      scrollHeight: 5000,
      viewportWidth: 1280,
      viewportHeight: 800,
    });
    const cdpClient = createMockCDPClientForDOM(simpleDoc);

    const result = await serializeDOM(page as never, cdpClient as never);

    expect(result.pageStats).toMatchObject({
      url: 'https://test.com/path',
      title: 'My Page',
      scrollX: 10,
      scrollY: 20,
      scrollWidth: 2560,
      scrollHeight: 5000,
      viewportWidth: 1280,
      viewportHeight: 800,
    });
    // All 8 properties present
    expect(Object.keys(result.pageStats)).toHaveLength(8);
  });

  test('page_stats header reflects actual page stats values', async () => {
    const page = createMockPageForDOM({
      url: 'https://verify.com',
      title: 'Verify Title',
      scrollX: 50,
      scrollY: 100,
      viewportWidth: 800,
      viewportHeight: 600,
    });
    const cdpClient = createMockCDPClientForDOM(emptyDoc);

    const result = await serializeDOM(page as never, cdpClient as never);

    expect(result.content).toContain('url: https://verify.com');
    expect(result.content).toContain('title: Verify Title');
    expect(result.content).toContain('scroll: 50,100');
    expect(result.content).toContain('viewport: 800x600');
  });

  // 12. CDP is called correctly
  test('calls CDP DOM.getDocument with correct params', async () => {
    const page = createMockPageForDOM();
    const cdpClient = createMockCDPClientForDOM(simpleDoc);

    await serializeDOM(page as never, cdpClient as never);

    expect(cdpClient.send).toHaveBeenCalledWith(
      page,
      'DOM.getDocument',
      { depth: -1, pierce: true },
    );
  });
});
