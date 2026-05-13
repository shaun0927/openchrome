/// <reference types="jest" />

import { serializeDOM } from '../../src/dom/dom-serializer';

// ─── Mock helpers ────────────────────────────────────────────────────────────

function createStats(stats: Record<string, unknown> = {}) {
  return {
    url: 'https://example.com',
    title: 'Test Page',
    scrollX: 0,
    scrollY: 0,
    scrollWidth: 1920,
    scrollHeight: 3000,
    viewportWidth: 1920,
    viewportHeight: 1080,
    ...stats,
  };
}

function createMockPageForDOM(stats: Record<string, unknown> = {}) {
  return {
    evaluate: jest.fn().mockResolvedValue(createStats(stats)),
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

  test('escapes quotes and ampersands in kept attribute values', async () => {
    const docWithSpecialAttrs = {
      nodeId: 1, backendNodeId: 1, nodeType: 9, nodeName: '#document', localName: '',
      children: [{
        nodeId: 2, backendNodeId: 2, nodeType: 1, nodeName: 'BODY', localName: 'body',
        attributes: [],
        children: [{
          nodeId: 3, backendNodeId: 301, nodeType: 1, nodeName: 'INPUT', localName: 'input',
          attributes: [
            'value', 'Tom & "Jerry" <Cartoon> > Show',
            'placeholder', 'Use "quotes" & <angle> brackets',
          ],
          children: [],
        }],
      }],
    };

    const page = createMockPageForDOM();
    const cdpClient = createMockCDPClientForDOM(docWithSpecialAttrs);

    const result = await serializeDOM(page as never, cdpClient as never, { includePageStats: false });
    const line = result.content.split('\n').find(l => l.includes('<input '));

    expect(line).toBeDefined();
    expect(line).toContain('value="Tom &amp; &quot;Jerry&quot; &lt;Cartoon&gt; &gt; Show"');
    expect(line).toContain('placeholder="Use &quot;quotes&quot; &amp; &lt;angle&gt; brackets"');
    expect(line).not.toContain('Tom & "Jerry" <Cartoon> > Show');
  });

  test('escapes attribute values that could inject fake attributes', async () => {
    const docWithInjectedAttrText = {
      nodeId: 1, backendNodeId: 1, nodeType: 9, nodeName: '#document', localName: '',
      children: [{
        nodeId: 2, backendNodeId: 2, nodeType: 1, nodeName: 'BODY', localName: 'body',
        attributes: [],
        children: [{
          nodeId: 3, backendNodeId: 302, nodeType: 1, nodeName: 'BUTTON', localName: 'button',
          attributes: [
            'aria-label', 'Save" data-testid="fake & confirm',
          ],
          children: [],
        }],
      }],
    };

    const page = createMockPageForDOM();
    const cdpClient = createMockCDPClientForDOM(docWithInjectedAttrText);

    const result = await serializeDOM(page as never, cdpClient as never, { includePageStats: false });
    const line = result.content.split('\n').find(l => l.includes('<button '));

    expect(line).toBeDefined();
    expect(line).toContain('aria-label="Save&quot; data-testid=&quot;fake &amp; confirm"');
    expect(line).not.toContain('data-testid="fake');
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

  test('includes cursor/onClick hints for custom interactive elements without leaking marker attrs', async () => {
    const customDoc = {
      nodeId: 1, backendNodeId: 1, nodeType: 9, nodeName: '#document', localName: '',
      children: [{
        nodeId: 2, backendNodeId: 2, nodeType: 1, nodeName: 'BODY', localName: 'body',
        attributes: [],
        children: [
          {
            nodeId: 3, backendNodeId: 910, nodeType: 1, nodeName: 'DIV', localName: 'div',
            attributes: ['class', 'card'],
            children: [{
              nodeId: 4, backendNodeId: 4, nodeType: 3, nodeName: '#text', localName: '',
              nodeValue: 'Open settings',
            }],
          },
          {
            nodeId: 5, backendNodeId: 911, nodeType: 1, nodeName: 'DIV', localName: 'div',
            attributes: ['class', 'plain'],
            children: [],
          },
        ],
      }],
    };

    const page = {
      evaluate: jest.fn()
        .mockResolvedValueOnce(createStats())
        .mockResolvedValueOnce({ completed: true, inspected: 1, hints: [{ path: 'd/c:0/c:0', hints: 'cursor:pointer, onclick' }] }),
    };
    const cdpClient = createMockCDPClientForDOM(customDoc);

    const result = await serializeDOM(page as never, cdpClient as never, { includePageStats: false, interactiveOnly: true });

    expect(result.content).toContain('[910]<div class="card"/>Open settings ★ [cursor:pointer, onclick]');
    expect(result.content).not.toContain('[911]');
    expect(result.content).not.toContain('data-oc-interactive-hints');
  });

  test('ignores page-authored interactive hint attributes without scan ownership', async () => {
    const forgedDoc = {
      nodeId: 1, backendNodeId: 1, nodeType: 9, nodeName: '#document', localName: '',
      children: [{
        nodeId: 2, backendNodeId: 2, nodeType: 1, nodeName: 'BODY', localName: 'body',
        attributes: [],
        children: [{
          nodeId: 3, backendNodeId: 912, nodeType: 1, nodeName: 'DIV', localName: 'div',
          attributes: ['data-oc-interactive-hints', 'cursor:pointer'],
          children: [],
        }],
      }],
    };
    const page = {
      evaluate: jest.fn()
        .mockResolvedValueOnce(createStats())
        .mockResolvedValueOnce({ completed: true, inspected: 1, hints: [] }),
    };
    const cdpClient = createMockCDPClientForDOM(forgedDoc);

    const result = await serializeDOM(page as never, cdpClient as never, { includePageStats: false, interactiveOnly: true });

    expect(result.content).not.toContain('[912]');
    expect(result.content).not.toContain('data-oc-interactive-hints');
  });

  // 8. Output truncation
  test('truncates output at maxOutputChars', async () => {
    // Build a large DOM with many nodes
    const manyChildren = Array.from({ length: 100 }, (_, i) => ({
      nodeId: 100 + i, backendNodeId: 1000 + i, nodeType: 1,
      nodeName: 'P', localName: 'p', attributes: ['id', `para-${i}`],
      children: [{
        nodeId: 200 + i, backendNodeId: 200 + i, nodeType: 3,
        nodeName: '#text', localName: '',
        nodeValue: `This is paragraph number ${i} with unique long text content to prevent sibling deduplication compression.`,
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
    expect(result.content).toContain('[Output truncated at 500 chars. Use depth parameter to limit scope.]');
  });

  test('bounds page_stats header with huge URL and title', async () => {
    const page = createMockPageForDOM({
      url: `https://example.com/${'u'.repeat(1000)}`,
      title: 't'.repeat(1000),
    });
    const cdpClient = createMockCDPClientForDOM(simpleDoc);

    const result = await serializeDOM(page as never, cdpClient as never, { maxOutputChars: 120 });

    expect(result.truncated).toBe(true);
    expect(result.content.length).toBeLessThanOrEqual(120);
    expect(result.content).toBe('\n\n[Output truncated at 120 chars. Use depth parameter to limit scope.]');
    expect(result.content).not.toContain('u'.repeat(100));
    expect(result.content).not.toContain('t'.repeat(100));
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

  test('keeps open shadow roots while omitting iframe content when pierceIframes is false', async () => {
    const shadowAndIframeDoc = {
      nodeId: 1, backendNodeId: 1, nodeType: 9, nodeName: '#document', localName: '',
      children: [{
        nodeId: 2, backendNodeId: 2, nodeType: 1, nodeName: 'BODY', localName: 'body',
        attributes: [],
        children: [
          {
            nodeId: 3, backendNodeId: 1300, nodeType: 1, nodeName: 'DIV', localName: 'div',
            attributes: ['id', 'shadow-host'],
            shadowRoots: [{
              nodeId: 4, backendNodeId: 4, nodeType: 11, nodeName: '#document-fragment', localName: '',
              shadowRootType: 'open',
              children: [{
                nodeId: 5, backendNodeId: 1301, nodeType: 1, nodeName: 'BUTTON', localName: 'button',
                attributes: ['id', 'shadow-button'],
                children: [{
                  nodeId: 6, backendNodeId: 6, nodeType: 3, nodeName: '#text', localName: '',
                  nodeValue: 'Shadow button',
                }],
              }],
            }],
          },
          {
            nodeId: 7, backendNodeId: 1302, nodeType: 1, nodeName: 'IFRAME', localName: 'iframe',
            attributes: ['src', 'https://inner.example.com'],
            contentDocument: {
              nodeId: 8, backendNodeId: 8, nodeType: 9, nodeName: '#document', localName: '',
              children: [{
                nodeId: 9, backendNodeId: 1303, nodeType: 1, nodeName: 'P', localName: 'p',
                attributes: ['id', 'iframe-content'],
                children: [],
              }],
            },
          },
        ],
      }],
    };

    const page = createMockPageForDOM();
    const cdpClient = createMockCDPClientForDOM(shadowAndIframeDoc);

    const result = await serializeDOM(page as never, cdpClient as never, { includePageStats: false, pierceIframes: false });

    expect(result.content).toContain('--shadow-root-- (open)');
    expect(result.content).toContain('[1301]<button');
    expect(result.content).toContain('Shadow button');
    expect(result.content).toContain('[1302]<iframe');
    expect(result.content).not.toContain('--page-separator--');
    expect(result.content).not.toContain('[1303]<p');
    expect(result.content).not.toContain('id="iframe-content"');
    expect(cdpClient.send).toHaveBeenCalledWith(
      page,
      'DOM.getDocument',
      { depth: -1, pierce: true },
    );
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

  test('passes bounded depth to CDP DOM.getDocument when maxDepth is requested without iframe output', async () => {
    // Iframe output is disabled here, so the serializer-depth-to-CDP-depth
    // mapping is exact for emitted nodes (offset by 1 for the #document root)
    // and the bounded fetch is safe. CDP still pierces so shadowRoots are
    // available to the serializer.
    const page = createMockPageForDOM();
    const cdpClient = createMockCDPClientForDOM(simpleDoc);

    await serializeDOM(page as never, cdpClient as never, { maxDepth: 2, pierceIframes: false });

    expect(cdpClient.send).toHaveBeenCalledWith(
      page,
      'DOM.getDocument',
      { depth: 3, pierce: true },
    );
  });

  test('falls back to unbounded fetch when maxDepth is set with pierceIframes=true', async () => {
    const page = createMockPageForDOM();
    const cdpClient = createMockCDPClientForDOM(simpleDoc);

    await serializeDOM(page as never, cdpClient as never, { maxDepth: 2 });

    expect(cdpClient.send).toHaveBeenCalledWith(
      page,
      'DOM.getDocument',
      { depth: -1, pierce: true },
    );
  });

  test('still pierces CDP DOM when pierceIframes=false for unbounded document fetches', async () => {
    const page = createMockPageForDOM();
    const cdpClient = createMockCDPClientForDOM(simpleDoc);

    await serializeDOM(page as never, cdpClient as never, { pierceIframes: false });

    expect(cdpClient.send).toHaveBeenCalledWith(
      page,
      'DOM.getDocument',
      { depth: -1, pierce: true },
    );
  });

  // 13. Bounded depth + iframe pierce regression
  // Document handler iterates contentDocument children at the same
  // serializer-depth, but each pierce hop costs a CDP depth level. With
  // pierceIframes=true the serializer must request unbounded depth so
  // iframe body content within maxDepth is not silently dropped.
  test('bounded maxDepth + pierceIframes renders iframe body content', async () => {
    // Layout (serializer / CDP depths):
    //   #document (s—, c0)
    //     html      (s0, c1)
    //       body    (s1, c2)
    //         iframe(s2, c3)
    //           contentDocument (handler same-depth s3, c4)
    //             html  (s3, c5)
    //               body(s4, c6)            ← within maxDepth=4 budget
    //                 p (s5, c7)            ← outside maxDepth
    //
    // A naive bounded fetch (depth = maxDepth + 1 = 5) would stop at
    // inner-html, dropping inner-body silently. The serializer guards
    // against this by requesting unbounded depth when pierceIframes is
    // true, so the simulated CDP response below contains the full tree.
    const fullDoc = {
      nodeId: 1, backendNodeId: 1, nodeType: 9, nodeName: '#document', localName: '',
      children: [{
        nodeId: 2, backendNodeId: 2, nodeType: 1, nodeName: 'HTML', localName: 'html',
        attributes: [],
        children: [{
          nodeId: 3, backendNodeId: 3, nodeType: 1, nodeName: 'BODY', localName: 'body',
          attributes: [],
          children: [{
            nodeId: 4, backendNodeId: 4000, nodeType: 1, nodeName: 'IFRAME', localName: 'iframe',
            attributes: ['src', 'https://inner.example.com'],
            contentDocument: {
              nodeId: 10, backendNodeId: 10, nodeType: 9, nodeName: '#document', localName: '',
              children: [{
                nodeId: 11, backendNodeId: 11, nodeType: 1, nodeName: 'HTML', localName: 'html',
                attributes: [],
                children: [{
                  nodeId: 12, backendNodeId: 12, nodeType: 1, nodeName: 'BODY', localName: 'body',
                  attributes: [],
                  children: [{
                    nodeId: 13, backendNodeId: 4001, nodeType: 1, nodeName: 'P', localName: 'p',
                    attributes: ['id', 'iframe-content'],
                    children: [],
                  }],
                }],
              }],
            },
          }],
        }],
      }],
    };

    const page = createMockPageForDOM();
    const cdpClient = createMockCDPClientForDOM(fullDoc);

    const result = await serializeDOM(page as never, cdpClient as never, {
      includePageStats: false,
      maxDepth: 4,
      pierceIframes: true,
    });

    // CDP must be asked for an unbounded fetch so iframe content is
    // not silently truncated.
    expect(cdpClient.send).toHaveBeenCalledWith(
      page,
      'DOM.getDocument',
      { depth: -1, pierce: true },
    );

    // Inner body shows up after the iframe page separator, and inner
    // body's children at serializer-depth 5 are correctly cut by the
    // maxDepth check (not by missing CDP data).
    expect(result.content).toContain('--page-separator-- iframe: https://inner.example.com');
    expect(result.content).toMatch(/--page-separator--[\s\S]*\[12\]<body/);
    expect(result.content).not.toContain('id="iframe-content"');
  });

  it('continues when cursor hint discovery fails', async () => {
    const page = createMockPageForDOM();
    const cdpClient = createMockCDPClientForDOM(simpleDoc);
    page.evaluate = jest.fn()
      .mockResolvedValueOnce({ nodeCount: 1, textLength: 4, truncated: false })
      .mockRejectedValueOnce(new Error('hint scan failed'))
      .mockResolvedValueOnce(undefined);

    const result = await serializeDOM(page as never, cdpClient as never, { interactiveOnly: true });

    expect(result.content).toEqual(expect.any(String));
    expect(cdpClient.send).toHaveBeenCalledWith(page, 'DOM.getDocument', { depth: -1, pierce: true });
  });

  it('treats computed contenteditable controls as interactive hints', async () => {
    const page = createMockPageForDOM();
    const cdpClient = createMockCDPClientForDOM(simpleDoc);
    page.evaluate = jest.fn()
      .mockResolvedValueOnce({ nodeCount: 1, textLength: 4, truncated: false })
      .mockImplementationOnce(async (fn: Function, hintAttr: string) => {
        const el = {
          tagName: 'DIV',
          shadowRoot: null,
          onclick: null,
          isContentEditable: true,
          getAttribute: (name: string) => name === 'contenteditable' ? 'plaintext-only' : null,
          hasAttribute: () => false,
          setAttribute: jest.fn(),
        };
        const root = { querySelectorAll: () => [el] };
        const previousDocument = (global as any).document;
        (global as any).document = root;
        try { await fn(hintAttr); } finally { (global as any).document = previousDocument; }
        expect(el.setAttribute).toHaveBeenCalledWith(hintAttr, 'editable');
      })
      .mockResolvedValueOnce(undefined);

    await serializeDOM(page as never, cdpClient as never, { interactiveOnly: true });
  });
});
