/// <reference types="jest" />

import {
  getAllShadowRoots,
  querySelectorInShadowRoots,
  discoverShadowElements,
} from '../../src/utils/shadow-dom';

// ─── Mock helpers ─────────────────────────────────────────────────────────────

const mockPage = {} as any;

function makeCDPClient(
  handler: (_page: unknown, method: string, params?: unknown) => Promise<unknown>,
) {
  return { send: jest.fn().mockImplementation(handler) };
}

// ─── DOM tree fixtures ────────────────────────────────────────────────────────

/** Document with no shadow roots — only regular light DOM. */
const domTreeNoShadow = {
  nodeId: 1, backendNodeId: 1, nodeType: 9, nodeName: '#document', localName: '',
  children: [{
    nodeId: 2, backendNodeId: 2, nodeType: 1, nodeName: 'BODY', localName: 'body',
    attributes: [],
    children: [{
      nodeId: 3, backendNodeId: 300, nodeType: 1, nodeName: 'DIV', localName: 'div',
      attributes: ['id', 'plain'],
      children: [],
    }],
  }],
};

/** Document with a single open shadow root on a div host. */
const domTreeWithOpenShadow = {
  nodeId: 1, backendNodeId: 1, nodeType: 9, nodeName: '#document', localName: '',
  children: [{
    nodeId: 2, backendNodeId: 2, nodeType: 1, nodeName: 'BODY', localName: 'body',
    attributes: [],
    children: [{
      nodeId: 3, backendNodeId: 300, nodeType: 1, nodeName: 'DIV', localName: 'div',
      attributes: ['id', 'host'],
      shadowRoots: [{
        nodeId: 10, backendNodeId: 10, nodeType: 11, nodeName: '#document-fragment',
        localName: '', shadowRootType: 'open',
        children: [{
          nodeId: 11, backendNodeId: 1100, nodeType: 1, nodeName: 'BUTTON', localName: 'button',
          attributes: ['aria-label', 'Shadow Button'],
          children: [{
            nodeId: 12, backendNodeId: 12, nodeType: 3, nodeName: '#text', localName: '',
            nodeValue: 'Click Me',
          }],
        }],
      }],
      children: [],
    }],
  }],
};

/** Document with a closed shadow root. */
const domTreeWithClosedShadow = {
  nodeId: 1, backendNodeId: 1, nodeType: 9, nodeName: '#document', localName: '',
  children: [{
    nodeId: 2, backendNodeId: 2, nodeType: 1, nodeName: 'BODY', localName: 'body',
    attributes: [],
    children: [{
      nodeId: 3, backendNodeId: 300, nodeType: 1, nodeName: 'SPAN', localName: 'span',
      attributes: ['id', 'closed-host'],
      shadowRoots: [{
        nodeId: 20, backendNodeId: 20, nodeType: 11, nodeName: '#document-fragment',
        localName: '', shadowRootType: 'closed',
        children: [],
      }],
      children: [],
    }],
  }],
};

/** Document with a user-agent shadow root. */
const domTreeWithUserAgentShadow = {
  nodeId: 1, backendNodeId: 1, nodeType: 9, nodeName: '#document', localName: '',
  children: [{
    nodeId: 2, backendNodeId: 2, nodeType: 1, nodeName: 'BODY', localName: 'body',
    attributes: [],
    children: [{
      nodeId: 3, backendNodeId: 300, nodeType: 1, nodeName: 'INPUT', localName: 'input',
      attributes: ['type', 'range'],
      shadowRoots: [{
        nodeId: 30, backendNodeId: 30, nodeType: 11, nodeName: '#document-fragment',
        localName: '', shadowRootType: 'user-agent',
        children: [],
      }],
      children: [],
    }],
  }],
};

/** Document with nested shadow roots (shadow root inside shadow root). */
const domTreeWithNestedShadow = {
  nodeId: 1, backendNodeId: 1, nodeType: 9, nodeName: '#document', localName: '',
  children: [{
    nodeId: 2, backendNodeId: 2, nodeType: 1, nodeName: 'BODY', localName: 'body',
    attributes: [],
    children: [{
      nodeId: 3, backendNodeId: 300, nodeType: 1, nodeName: 'DIV', localName: 'div',
      attributes: ['id', 'outer-host'],
      shadowRoots: [{
        nodeId: 10, backendNodeId: 10, nodeType: 11, nodeName: '#document-fragment',
        localName: '', shadowRootType: 'open',
        children: [{
          // inner host inside the outer shadow root
          nodeId: 40, backendNodeId: 400, nodeType: 1, nodeName: 'SECTION', localName: 'section',
          attributes: ['id', 'inner-host'],
          shadowRoots: [{
            nodeId: 50, backendNodeId: 50, nodeType: 11, nodeName: '#document-fragment',
            localName: '', shadowRootType: 'open',
            children: [],
          }],
          children: [],
        }],
      }],
      children: [],
    }],
  }],
};

/** Document with shadow root inside an iframe's contentDocument. */
const domTreeWithIframeShadow = {
  nodeId: 1, backendNodeId: 1, nodeType: 9, nodeName: '#document', localName: '',
  children: [{
    nodeId: 2, backendNodeId: 2, nodeType: 1, nodeName: 'BODY', localName: 'body',
    attributes: [],
    children: [{
      nodeId: 3, backendNodeId: 3, nodeType: 1, nodeName: 'IFRAME', localName: 'iframe',
      attributes: ['src', 'https://inner.example.com'],
      contentDocument: {
        nodeId: 60, backendNodeId: 60, nodeType: 9, nodeName: '#document', localName: '',
        children: [{
          nodeId: 61, backendNodeId: 610, nodeType: 1, nodeName: 'DIV', localName: 'div',
          attributes: ['id', 'iframe-host'],
          shadowRoots: [{
            nodeId: 70, backendNodeId: 70, nodeType: 11, nodeName: '#document-fragment',
            localName: '', shadowRootType: 'open',
            children: [],
          }],
          children: [],
        }],
      },
    }],
  }],
};

// ─── getAllShadowRoots ─────────────────────────────────────────────────────────

describe('getAllShadowRoots', () => {
  function makeCDPForTree(domTree: unknown) {
    return makeCDPClient(async (_page, method) => {
      if (method === 'DOM.getDocument') return { root: domTree };
      return {};
    });
  }

  test('returns empty array when no shadow roots exist', async () => {
    const cdpClient = makeCDPForTree(domTreeNoShadow);
    const { shadowRoots } = await getAllShadowRoots(mockPage, cdpClient as any);
    expect(shadowRoots).toEqual([]);
  });

  test('finds open shadow root', async () => {
    const cdpClient = makeCDPForTree(domTreeWithOpenShadow);
    const { shadowRoots } = await getAllShadowRoots(mockPage, cdpClient as any);
    expect(shadowRoots).toHaveLength(1);
    expect(shadowRoots[0]).toMatchObject({
      hostNodeId: 3,
      hostBackendNodeId: 300,
      shadowRootNodeId: 10,
      shadowRootType: 'open',
    });
  });

  test('finds closed shadow root', async () => {
    const cdpClient = makeCDPForTree(domTreeWithClosedShadow);
    const { shadowRoots } = await getAllShadowRoots(mockPage, cdpClient as any);
    expect(shadowRoots).toHaveLength(1);
    expect(shadowRoots[0]).toMatchObject({
      hostNodeId: 3,
      hostBackendNodeId: 300,
      shadowRootNodeId: 20,
      shadowRootType: 'closed',
    });
  });

  test('finds user-agent shadow root', async () => {
    const cdpClient = makeCDPForTree(domTreeWithUserAgentShadow);
    const { shadowRoots } = await getAllShadowRoots(mockPage, cdpClient as any);
    expect(shadowRoots).toHaveLength(1);
    expect(shadowRoots[0].shadowRootType).toBe('user-agent');
  });

  test('finds nested shadow roots (shadow root inside shadow root)', async () => {
    const cdpClient = makeCDPForTree(domTreeWithNestedShadow);
    const { shadowRoots } = await getAllShadowRoots(mockPage, cdpClient as any);
    // outer root (nodeId 10) + inner root (nodeId 50)
    expect(shadowRoots).toHaveLength(2);
    const nodeIds = shadowRoots.map(sr => sr.shadowRootNodeId);
    expect(nodeIds).toContain(10);
    expect(nodeIds).toContain(50);
  });

  test('finds shadow roots inside iframes (contentDocument)', async () => {
    const cdpClient = makeCDPForTree(domTreeWithIframeShadow);
    const { shadowRoots } = await getAllShadowRoots(mockPage, cdpClient as any);
    expect(shadowRoots).toHaveLength(1);
    expect(shadowRoots[0]).toMatchObject({
      hostNodeId: 61,
      hostBackendNodeId: 610,
      shadowRootNodeId: 70,
    });
  });

  test('returns the full domTree alongside shadow roots', async () => {
    const cdpClient = makeCDPForTree(domTreeWithOpenShadow);
    const { domTree } = await getAllShadowRoots(mockPage, cdpClient as any);
    expect(domTree).toMatchObject({ nodeId: 1, nodeName: '#document' });
  });

  test('calls DOM.getDocument with depth: -1 and pierce: true', async () => {
    const cdpClient = makeCDPForTree(domTreeNoShadow);
    await getAllShadowRoots(mockPage, cdpClient as any);
    expect(cdpClient.send).toHaveBeenCalledWith(
      mockPage,
      'DOM.getDocument',
      { depth: -1, pierce: true },
    );
  });
});

// ─── querySelectorInShadowRoots ───────────────────────────────────────────────

describe('querySelectorInShadowRoots', () => {
  const singleShadowRoot = [{
    hostNodeId: 3,
    hostBackendNodeId: 300,
    shadowRootNodeId: 10,
    shadowRootType: 'open',
  }];

  const twoShadowRoots = [
    { hostNodeId: 3, hostBackendNodeId: 300, shadowRootNodeId: 10, shadowRootType: 'open' },
    { hostNodeId: 5, hostBackendNodeId: 500, shadowRootNodeId: 20, shadowRootType: 'open' },
  ];

  test('returns empty array when no shadow roots provided', async () => {
    const cdpClient = makeCDPClient(async () => ({}));
    const result = await querySelectorInShadowRoots(
      mockPage, cdpClient as any, 'button', [],
    );
    expect(result).toEqual([]);
    expect(cdpClient.send).not.toHaveBeenCalled();
  });

  test('returns backendNodeIds for matching elements', async () => {
    const cdpClient = makeCDPClient(async (_page, method, params: any) => {
      if (method === 'DOM.querySelectorAll') return { nodeIds: [11] };
      if (method === 'DOM.describeNode' && params?.nodeId === 11) {
        return { node: { backendNodeId: 1100 } };
      }
      return {};
    });

    const result = await querySelectorInShadowRoots(
      mockPage, cdpClient as any, 'button', singleShadowRoot,
    );
    expect(result).toEqual([1100]);
  });

  test('handles multiple shadow roots with matches in each', async () => {
    const cdpClient = makeCDPClient(async (_page, method, params: any) => {
      if (method === 'DOM.querySelectorAll') {
        // Each shadow root returns one nodeId unique to itself
        if (params?.nodeId === 10) return { nodeIds: [101] };
        if (params?.nodeId === 20) return { nodeIds: [201] };
        return { nodeIds: [] };
      }
      if (method === 'DOM.describeNode') {
        if (params?.nodeId === 101) return { node: { backendNodeId: 1010 } };
        if (params?.nodeId === 201) return { node: { backendNodeId: 2010 } };
      }
      return {};
    });

    const result = await querySelectorInShadowRoots(
      mockPage, cdpClient as any, 'button', twoShadowRoots,
    );
    expect(result).toContain(1010);
    expect(result).toContain(2010);
    expect(result).toHaveLength(2);
  });

  test('handles CDP errors gracefully and returns partial results', async () => {
    const cdpClient = makeCDPClient(async (_page, method, params: any) => {
      if (method === 'DOM.querySelectorAll') {
        // First shadow root (nodeId 10) succeeds, second (nodeId 20) throws
        if (params?.nodeId === 10) return { nodeIds: [101] };
        throw new Error('CDP error: node not found');
      }
      if (method === 'DOM.describeNode' && params?.nodeId === 101) {
        return { node: { backendNodeId: 1010 } };
      }
      return {};
    });

    // Should not throw — returns whatever succeeded
    const result = await querySelectorInShadowRoots(
      mockPage, cdpClient as any, 'button', twoShadowRoots,
    );
    expect(result).toEqual([1010]);
  });

  test('skips shadow roots where querySelectorAll returns empty nodeIds', async () => {
    const cdpClient = makeCDPClient(async (_page, method) => {
      if (method === 'DOM.querySelectorAll') return { nodeIds: [] };
      return {};
    });

    const result = await querySelectorInShadowRoots(
      mockPage, cdpClient as any, '.nonexistent', singleShadowRoot,
    );
    expect(result).toEqual([]);
    expect(cdpClient.send).not.toHaveBeenCalledWith(mockPage, 'DOM.describeNode', expect.anything());
  });

  test('handles describeNode failure for individual nodes gracefully', async () => {
    const cdpClient = makeCDPClient(async (_page, method, params: any) => {
      if (method === 'DOM.querySelectorAll') return { nodeIds: [101, 102] };
      if (method === 'DOM.describeNode') {
        // First resolves, second throws
        if (params?.nodeId === 101) return { node: { backendNodeId: 1010 } };
        throw new Error('stale node');
      }
      return {};
    });

    const result = await querySelectorInShadowRoots(
      mockPage, cdpClient as any, 'button', singleShadowRoot,
    );
    // Only the one that succeeded is in results
    expect(result).toEqual([1010]);
  });
});

// ─── discoverShadowElements ───────────────────────────────────────────────────

describe('discoverShadowElements', () => {
  /** Standard box model response for a visible 100x40 element at (50, 200). */
  function boxModel(x = 50, y = 200, w = 100, h = 40) {
    // CDP content quad: [x1,y1, x2,y2, x3,y3, x4,y4]
    return {
      model: {
        content: [x, y, x + w, y, x + w, y + h, x, y + h],
      },
    };
  }

  function makeCDPForDiscovery(
    domTree: unknown,
    boxModelFn: () => unknown = boxModel,
  ) {
    return makeCDPClient(async (_page, method) => {
      if (method === 'DOM.getDocument') return { root: domTree };
      if (method === 'DOM.getBoxModel') return boxModelFn();
      return {};
    });
  }

  test('returns empty array when no shadow roots on page', async () => {
    const cdpClient = makeCDPForDiscovery(domTreeNoShadow);
    const result = await discoverShadowElements(mockPage, cdpClient as any, 'anything');
    expect(result).toEqual([]);
  });

  test('discovers button inside shadow root by query text', async () => {
    const cdpClient = makeCDPForDiscovery(domTreeWithOpenShadow);
    const results = await discoverShadowElements(mockPage, cdpClient as any, 'Click Me');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      backendDOMNodeId: 1100,
      tagName: 'button',
      role: 'button',
    });
  });

  test('discovers button by aria-label', async () => {
    const cdpClient = makeCDPForDiscovery(domTreeWithOpenShadow);
    const results = await discoverShadowElements(mockPage, cdpClient as any, 'Shadow Button');
    expect(results).toHaveLength(1);
    expect(results[0].ariaLabel).toBe('Shadow Button');
  });

  test('prioritizes interactive elements in results', async () => {
    // DOM with both an interactive button and a plain div matching the query
    const domTree = {
      nodeId: 1, backendNodeId: 1, nodeType: 9, nodeName: '#document', localName: '',
      children: [{
        nodeId: 2, backendNodeId: 2, nodeType: 1, nodeName: 'BODY', localName: 'body',
        attributes: [],
        children: [{
          nodeId: 3, backendNodeId: 300, nodeType: 1, nodeName: 'DIV', localName: 'div',
          attributes: ['id', 'host'],
          shadowRoots: [{
            nodeId: 10, backendNodeId: 10, nodeType: 11, nodeName: '#document-fragment',
            localName: '', shadowRootType: 'open',
            children: [
              {
                // plain div — not interactive, but matches query text
                nodeId: 20, backendNodeId: 2000, nodeType: 1, nodeName: 'DIV', localName: 'div',
                attributes: [],
                children: [{
                  nodeId: 21, backendNodeId: 21, nodeType: 3, nodeName: '#text', localName: '',
                  nodeValue: 'Submit',
                }],
              },
              {
                // button — interactive, also matches
                nodeId: 22, backendNodeId: 2200, nodeType: 1, nodeName: 'BUTTON', localName: 'button',
                attributes: [],
                children: [{
                  nodeId: 23, backendNodeId: 23, nodeType: 3, nodeName: '#text', localName: '',
                  nodeValue: 'Submit',
                }],
              },
            ],
          }],
          children: [],
        }],
      }],
    };

    const cdpClient = makeCDPForDiscovery(domTree);
    const results = await discoverShadowElements(mockPage, cdpClient as any, 'Submit');

    expect(results.length).toBeGreaterThanOrEqual(1);
    // The button (interactive) must come first
    expect(results[0].tagName).toBe('button');
  });

  test('excludes elements whose backendNodeId is in excludeBackendIds', async () => {
    const cdpClient = makeCDPForDiscovery(domTreeWithOpenShadow);
    const results = await discoverShadowElements(
      mockPage, cdpClient as any, 'Click Me',
      { excludeBackendIds: new Set([1100]) },
    );
    expect(results).toEqual([]);
  });

  test('respects maxResults limit', async () => {
    // DOM with 5 matching buttons in a shadow root
    const shadowChildren = Array.from({ length: 5 }, (_, i) => ({
      nodeId: 100 + i,
      backendNodeId: 1000 + i,
      nodeType: 1,
      nodeName: 'BUTTON',
      localName: 'button',
      attributes: [],
      children: [{
        nodeId: 200 + i, backendNodeId: 200 + i, nodeType: 3,
        nodeName: '#text', localName: '', nodeValue: 'Click',
      }],
    }));

    const domTree = {
      nodeId: 1, backendNodeId: 1, nodeType: 9, nodeName: '#document', localName: '',
      children: [{
        nodeId: 2, backendNodeId: 2, nodeType: 1, nodeName: 'BODY', localName: 'body',
        attributes: [],
        children: [{
          nodeId: 3, backendNodeId: 300, nodeType: 1, nodeName: 'DIV', localName: 'div',
          attributes: [],
          shadowRoots: [{
            nodeId: 10, backendNodeId: 10, nodeType: 11, nodeName: '#document-fragment',
            localName: '', shadowRootType: 'open',
            children: shadowChildren,
          }],
          children: [],
        }],
      }],
    };

    const cdpClient = makeCDPForDiscovery(domTree);
    const results = await discoverShadowElements(
      mockPage, cdpClient as any, 'Click',
      { maxResults: 3 },
    );
    expect(results.length).toBeLessThanOrEqual(3);
  });

  test('returns correct rect coordinates from box model', async () => {
    const cdpClient = makeCDPForDiscovery(domTreeWithOpenShadow, () => boxModel(10, 20, 200, 50));
    const results = await discoverShadowElements(mockPage, cdpClient as any, 'Click Me');
    expect(results).toHaveLength(1);
    expect(results[0].rect).toEqual({ x: 10, y: 20, width: 200, height: 50 });
  });

  test('returns center coordinates when useCenter is true', async () => {
    const cdpClient = makeCDPForDiscovery(domTreeWithOpenShadow, () => boxModel(10, 20, 200, 50));
    const results = await discoverShadowElements(
      mockPage, cdpClient as any, 'Click Me',
      { useCenter: true },
    );
    expect(results).toHaveLength(1);
    expect(results[0].rect).toEqual({ x: 110, y: 45, width: 200, height: 50 });
  });

  test('skips elements with zero width', async () => {
    const cdpClient = makeCDPForDiscovery(domTreeWithOpenShadow, () => boxModel(10, 20, 0, 50));
    const results = await discoverShadowElements(mockPage, cdpClient as any, 'Click Me');
    expect(results).toEqual([]);
  });

  test('skips elements with zero height', async () => {
    const cdpClient = makeCDPForDiscovery(domTreeWithOpenShadow, () => boxModel(10, 20, 100, 0));
    const results = await discoverShadowElements(mockPage, cdpClient as any, 'Click Me');
    expect(results).toEqual([]);
  });

  test('skips elements where getBoxModel throws', async () => {
    const cdpClient = makeCDPClient(async (_page, method) => {
      if (method === 'DOM.getDocument') return { root: domTreeWithOpenShadow };
      if (method === 'DOM.getBoxModel') throw new Error('no layout');
      return {};
    });

    const results = await discoverShadowElements(mockPage, cdpClient as any, 'Click Me');
    expect(results).toEqual([]);
  });

  test('returns empty when query does not match any shadow element', async () => {
    const cdpClient = makeCDPForDiscovery(domTreeWithOpenShadow);
    const results = await discoverShadowElements(
      mockPage, cdpClient as any, 'nonexistent-xyz-query',
    );
    expect(results).toEqual([]);
  });

  test('includes textContent on returned elements', async () => {
    const cdpClient = makeCDPForDiscovery(domTreeWithOpenShadow);
    const results = await discoverShadowElements(mockPage, cdpClient as any, 'Click Me');
    expect(results[0].textContent).toBe('Click Me');
  });

  test('inferRole: returns "button" for button tag', async () => {
    const cdpClient = makeCDPForDiscovery(domTreeWithOpenShadow);
    const results = await discoverShadowElements(mockPage, cdpClient as any, 'Click Me');
    expect(results[0].role).toBe('button');
  });

  test('inferRole: returns explicit role attribute when present', async () => {
    const domTree = {
      nodeId: 1, backendNodeId: 1, nodeType: 9, nodeName: '#document', localName: '',
      children: [{
        nodeId: 2, backendNodeId: 2, nodeType: 1, nodeName: 'BODY', localName: 'body',
        attributes: [],
        children: [{
          nodeId: 3, backendNodeId: 300, nodeType: 1, nodeName: 'DIV', localName: 'div',
          attributes: [],
          shadowRoots: [{
            nodeId: 10, backendNodeId: 10, nodeType: 11, nodeName: '#document-fragment',
            localName: '', shadowRootType: 'open',
            children: [{
              nodeId: 11, backendNodeId: 1100, nodeType: 1, nodeName: 'DIV', localName: 'div',
              attributes: ['role', 'tab', 'aria-label', 'Settings Tab'],
              children: [],
            }],
          }],
          children: [],
        }],
      }],
    };

    const cdpClient = makeCDPForDiscovery(domTree);
    const results = await discoverShadowElements(mockPage, cdpClient as any, 'Settings Tab');
    expect(results[0].role).toBe('tab');
  });

  test('does not include light DOM elements as shadow candidates', async () => {
    // The plain div in the light DOM should not appear even if it matches
    const cdpClient = makeCDPForDiscovery(domTreeNoShadow);
    const results = await discoverShadowElements(mockPage, cdpClient as any, 'plain');
    // No shadow roots → empty early return
    expect(results).toEqual([]);
  });
});
