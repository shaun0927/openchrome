/// <reference types="jest" />

import { serializeDOM } from '../../src/dom/dom-serializer';

function createMockElement(overrides: Record<string, unknown> = {}) {
  const initialAttributes = new Map<string, string>(Object.entries(
    (overrides.attributes as Record<string, string> | undefined) ?? {},
  ));
  const element: any = {
    attributes: initialAttributes,
    removedAttributes: [] as string[],
    tagName: 'DIV',
    shadowRoot: null,
    onclick: null,
    parentElement: null,
    isContentEditable: false,
    computedStyle: { cursor: 'default', display: 'block', visibility: 'visible' },
    closest: jest.fn(() => null),
    getAttribute: jest.fn((name: string) => initialAttributes.get(name) ?? null),
    hasAttribute: jest.fn((name: string) => initialAttributes.has(name)),
    setAttribute: jest.fn((name: string, value: string) => { initialAttributes.set(name, value); }),
    removeAttribute: jest.fn((name: string) => {
      initialAttributes.delete(name);
      element.removedAttributes.push(name);
    }),
    querySelector: jest.fn(() => null),
    getBoundingClientRect: jest.fn(() => ({ width: 10, height: 10 })),
    ...overrides,
  };
  element.attributes = initialAttributes;
  return element;
}

async function withMockTreeWalker(elements: any[], run: () => void | Promise<void>) {
  const previousDocument = (global as any).document;
  const previousNodeFilter = (global as any).NodeFilter;
  const previousPerformance = (global as any).performance;
  const previousGetComputedStyle = (global as any).getComputedStyle;

  const documentRoot: any = { nodes: elements };
  for (const element of elements) {
    if (!element.parentNode) element.parentNode = documentRoot;
  }

  (global as any).document = {
    createTreeWalker: (root: { nodes?: any[] }) => {
      const nodes = root.nodes ?? [];
      let index = -1;
      return {
        nextNode: () => nodes[++index] ?? null,
      };
    },
    querySelectorAll: () => elements,
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
    return await run();
  } finally {
    (global as any).document = previousDocument;
    (global as any).NodeFilter = previousNodeFilter;
    (global as any).performance = previousPerformance;
    (global as any).getComputedStyle = previousGetComputedStyle;
  }
}

function createStats() {
  return {
    url: 'https://example.com',
    title: 'Test Page',
    scrollX: 0,
    scrollY: 0,
    scrollWidth: 1920,
    scrollHeight: 3000,
    viewportWidth: 1920,
    viewportHeight: 1080,
  };
}

function createDoc(children: any[]) {
  return {
    nodeId: 1, backendNodeId: 1, nodeType: 9, nodeName: '#document', localName: '',
    children: [{
      nodeId: 2, backendNodeId: 2, nodeType: 1, nodeName: 'BODY', localName: 'body',
      attributes: [],
      children,
    }],
  };
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
        .mockResolvedValueOnce(createStats())
        .mockImplementationOnce(async (
          fn: Function,
          maxMs: number,
          maxElements: number,
          includeIframes: boolean,
        ) => {
          const elements = Array.from({ length: maxElements + 5 }, () => createMockElement({
            computedStyle: { cursor: 'pointer', display: 'block', visibility: 'visible' },
          }));
          const result = await withMockTreeWalker(elements, () => fn(maxMs, maxElements, includeIframes));
          expect(elements[maxElements - 1].setAttribute).not.toHaveBeenCalled();
          expect(elements[maxElements].setAttribute).not.toHaveBeenCalled();
          return result;
        }),
    };
    const cdpClient = {
      send: jest.fn().mockResolvedValue({ root: nativeInteractiveDoc }),
    };

    const result = await serializeDOM(page as never, cdpClient as never, { interactiveOnly: true });

    expect(result.content).toContain('[930]<button/> ★');
    expect(cdpClient.send).toHaveBeenCalledWith(page, 'DOM.getDocument', { depth: -1, pierce: true });
  });

  it('falls back without custom hints and leaves the page untouched when the scan budget is exceeded', async () => {
    let cursorElement: any;
    const page = {
      evaluate: jest.fn()
        .mockResolvedValueOnce(createStats())
        .mockImplementationOnce(async (
          fn: Function,
          maxMs: number,
          maxElements: number,
          includeIframes: boolean,
        ) => {
          cursorElement = createMockElement({
            computedStyle: { cursor: 'pointer', display: 'block', visibility: 'visible' },
          });
          const elements = [
            cursorElement,
            ...Array.from({ length: maxElements }, () => createMockElement()),
          ];
          return await withMockTreeWalker(elements, () => fn(maxMs, maxElements, includeIframes));
        }),
    };
    const cdpClient = {
      send: jest.fn().mockImplementation(async () => {
        expect(cursorElement.setAttribute).not.toHaveBeenCalled();
        expect(cursorElement.removeAttribute).not.toHaveBeenCalled();
        return {
          root: createDoc([
            {
              nodeId: 3, backendNodeId: 940, nodeType: 1, nodeName: 'DIV', localName: 'div',
              attributes: [],
              children: [],
            },
            {
              nodeId: 4, backendNodeId: 941, nodeType: 1, nodeName: 'BUTTON', localName: 'button',
              attributes: [],
              children: [],
            },
          ]),
        };
      }),
    };

    const result = await serializeDOM(page as never, cdpClient as never, { includePageStats: false, interactiveOnly: true });

    expect(result.content).not.toContain('[940]');
    expect(result.content).toContain('[941]<button/> ★');
    expect(cursorElement.setAttribute).not.toHaveBeenCalled();
    expect(cursorElement.removeAttribute).not.toHaveBeenCalled();
  });

  it('ignores pre-existing page-authored interactive hint attributes', async () => {
    const existingElement = createMockElement({
      attributes: { 'data-oc-interactive-hints': 'existing' },
      computedStyle: { cursor: 'default', display: 'block', visibility: 'visible' },
    });
    const page = {
      evaluate: jest.fn()
        .mockResolvedValueOnce(createStats())
        .mockImplementationOnce(async (
          fn: Function,
          maxMs: number,
          maxElements: number,
          includeIframes: boolean,
        ) => await withMockTreeWalker([existingElement], () => fn(maxMs, maxElements, includeIframes))),
    };
    const cdpClient = {
      send: jest.fn().mockResolvedValue({
        root: createDoc([{
          nodeId: 3, backendNodeId: 950, nodeType: 1, nodeName: 'DIV', localName: 'div',
          attributes: ['data-oc-interactive-hints', 'existing'],
          children: [],
        }]),
      }),
    };

    const result = await serializeDOM(page as never, cdpClient as never, { includePageStats: false, interactiveOnly: true });

    expect(result.content).not.toContain('[950]');
    expect(result.content).not.toContain('existing');
    expect(existingElement.setAttribute).not.toHaveBeenCalled();
    expect(existingElement.removeAttribute).not.toHaveBeenCalled();
  });

  it('includes regular cursor custom controls when the scan completes', async () => {
    const cursorElement = createMockElement({
      computedStyle: { cursor: 'pointer', display: 'block', visibility: 'visible' },
    });
    const page = {
      evaluate: jest.fn()
        .mockResolvedValueOnce(createStats())
        .mockResolvedValueOnce({ completed: true, inspected: 1, hints: [{ path: 'd/c:0/c:0', hints: 'cursor:pointer' }] }),
    };
    const cdpClient = {
      send: jest.fn().mockImplementation(async () => ({
        root: createDoc([{
          nodeId: 3, backendNodeId: 960, nodeType: 1, nodeName: 'DIV', localName: 'div',
          attributes: [],
          children: [{
            nodeId: 4, backendNodeId: 4, nodeType: 3, nodeName: '#text', localName: '',
            nodeValue: 'Open menu',
          }],
        }]),
      })),
    };

    const result = await serializeDOM(page as never, cdpClient as never, { includePageStats: false, interactiveOnly: true });

    expect(result.content).toContain('[960]<div/>Open menu ★ [cursor:pointer]');
    expect(cursorElement.setAttribute).not.toHaveBeenCalled();
    expect(cursorElement.removeAttribute).not.toHaveBeenCalled();
  });
});
