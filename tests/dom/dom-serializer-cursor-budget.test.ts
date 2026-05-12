/// <reference types="jest" />

import { serializeDOM } from '../../src/dom/dom-serializer';

function createMockElement(overrides: Record<string, unknown> = {}) {
  return {
    tagName: 'DIV',
    shadowRoot: null,
    onclick: null,
    parentElement: null,
    isContentEditable: false,
    computedStyle: { cursor: 'default', display: 'block', visibility: 'visible' },
    closest: jest.fn(() => null),
    getAttribute: jest.fn(() => null),
    hasAttribute: jest.fn(() => false),
    setAttribute: jest.fn(),
    querySelector: jest.fn(() => null),
    getBoundingClientRect: jest.fn(() => ({ width: 10, height: 10 })),
    ...overrides,
  };
}

async function withMockTreeWalker(elements: any[], run: () => void | Promise<void>) {
  const previousDocument = (global as any).document;
  const previousNodeFilter = (global as any).NodeFilter;
  const previousPerformance = (global as any).performance;
  const previousGetComputedStyle = (global as any).getComputedStyle;

  (global as any).document = {
    createTreeWalker: (root: { nodes?: any[] }) => {
      const nodes = root.nodes ?? [];
      let index = -1;
      return {
        nextNode: () => nodes[++index] ?? null,
      };
    },
    nodes: elements,
  };
  (global as any).NodeFilter = { SHOW_ELEMENT: 1 };
  (global as any).performance = { now: jest.fn(() => 0) };
  (global as any).getComputedStyle = jest.fn((el: any) => el.computedStyle ?? {
    cursor: 'default',
    display: 'block',
    visibility: 'visible',
  });

  try {
    await run();
  } finally {
    (global as any).document = previousDocument;
    (global as any).NodeFilter = previousNodeFilter;
    (global as any).performance = previousPerformance;
    (global as any).getComputedStyle = previousGetComputedStyle;
  }
}

describe('DOM serializer cursor hint scan budget', () => {
  it('stops cursor hint discovery at the node cap and keeps native interactive fallback', async () => {
    const nativeInteractiveDoc = {
      nodeId: 1, backendNodeId: 1, nodeType: 9, nodeName: '#document', localName: '',
      children: [{
        nodeId: 2, backendNodeId: 2, nodeType: 1, nodeName: 'BODY', localName: 'body',
        attributes: [],
        children: [{
          nodeId: 3, backendNodeId: 930, nodeType: 1, nodeName: 'BUTTON', localName: 'button',
          attributes: [],
          children: [],
        }],
      }],
    };
    const page = {
      evaluate: jest.fn()
        .mockResolvedValueOnce({
          url: 'https://example.com',
          title: 'Test Page',
          scrollX: 0,
          scrollY: 0,
          scrollWidth: 1920,
          scrollHeight: 3000,
          viewportWidth: 1920,
          viewportHeight: 1080,
        })
        .mockImplementationOnce(async (
          fn: Function,
          hintAttr: string,
          ownedAttr: string,
          maxMs: number,
          maxElements: number,
        ) => {
          const elements = Array.from({ length: maxElements + 5 }, () => createMockElement({
            computedStyle: { cursor: 'pointer', display: 'block', visibility: 'visible' },
          }));
          const skippedElement = elements[maxElements];

          await withMockTreeWalker(elements, () => fn(hintAttr, ownedAttr, maxMs, maxElements));

          expect(elements[maxElements - 1].setAttribute).toHaveBeenCalledWith(hintAttr, 'cursor:pointer');
          expect(elements[maxElements - 1].setAttribute).toHaveBeenCalledWith(ownedAttr, 'true');
          expect(skippedElement.setAttribute).not.toHaveBeenCalled();
        })
        .mockResolvedValueOnce(undefined),
    };
    const cdpClient = {
      send: jest.fn().mockResolvedValue({ root: nativeInteractiveDoc }),
    };

    const result = await serializeDOM(page as never, cdpClient as never, { interactiveOnly: true });

    expect(result.content).toContain('[930]<button/> ★');
    expect(cdpClient.send).toHaveBeenCalledWith(page, 'DOM.getDocument', { depth: -1, pierce: true });
  });
});
