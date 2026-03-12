/// <reference types="jest" />
/**
 * Tests for transparent stale ref auto-recovery via tryRelocateRef.
 *
 * Covers:
 * 1. Element re-found by text content -> returns new backendNodeId
 * 2. Element re-found by aria-label/name -> returns new backendNodeId
 * 3. Element genuinely gone -> returns null
 * 4. No metadata stored (no tagName) -> returns null
 * 5. computer tool recovers transparently on stale ref
 * 6. form_input tool recovers transparently on stale ref
 */

import { createMockSessionManager, createMockRefIdManager } from '../utils/mock-session';
import { RefIdManager } from '../../src/utils/ref-id-manager';
import { createMockPage } from '../utils/mock-cdp';

jest.mock('../../src/session-manager', () => ({ getSessionManager: jest.fn() }));
jest.mock('../../src/utils/ref-id-manager', () => {
  const actual = jest.requireActual('../../src/utils/ref-id-manager');
  return { ...actual, getRefIdManager: jest.fn() };
});

import { getSessionManager } from '../../src/session-manager';
import { getRefIdManager } from '../../src/utils/ref-id-manager';

// ---------------------------------------------------------------------------
// Unit tests for RefIdManager.tryRelocateRef
// ---------------------------------------------------------------------------
describe('RefIdManager.tryRelocateRef', () => {
  let manager: RefIdManager;
  const sessionId = 'session-1';
  const tabId = 'tab-1';

  beforeEach(() => {
    manager = new RefIdManager();
  });

  function makeCDPClient(backendNodeId: number | null) {
    return {
      send: jest.fn().mockImplementation(async (_page: unknown, method: string) => {
        if (method === 'Runtime.evaluate') {
          return { result: backendNodeId !== null ? { objectId: 'obj-mock' } : {} };
        }
        if (method === 'DOM.describeNode') {
          if (backendNodeId !== null) {
            return { node: { backendNodeId } };
          }
          throw new Error('Node not found');
        }
        return {};
      }),
    };
  }

  function makePage(evaluateResult: number) {
    const page = createMockPage();
    (page.evaluate as jest.Mock).mockResolvedValue(evaluateResult);
    return page;
  }

  test('returns null when ref does not exist', async () => {
    const page = makePage(0);
    const cdpClient = makeCDPClient(999);
    const result = await manager.tryRelocateRef(sessionId, tabId, 'ref_999', page as any, cdpClient);
    expect(result).toBeNull();
  });

  test('returns null when entry has no tagName', async () => {
    // generateRef without tagName
    const refId = manager.generateRef(sessionId, tabId, 100, 'button', 'Submit', undefined, undefined);
    const page = makePage(0);
    const cdpClient = makeCDPClient(null);
    const result = await manager.tryRelocateRef(sessionId, tabId, refId, page as any, cdpClient);
    expect(result).toBeNull();
  });

  test('returns null when element is not found in DOM (evaluate returns 0)', async () => {
    const refId = manager.generateRef(sessionId, tabId, 100, 'button', 'Submit', 'button', 'Submit');
    const page = makePage(0); // evaluate returns 0 = not found
    const cdpClient = makeCDPClient(null);
    const result = await manager.tryRelocateRef(sessionId, tabId, refId, page as any, cdpClient);
    expect(result).toBeNull();
  });

  test('returns new backendNodeId when element is re-found by text content', async () => {
    const refId = manager.generateRef(sessionId, tabId, 100, 'button', undefined, 'button', 'Click me');
    const page = makePage(1); // evaluate returns 1 = found
    const newBackendNodeId = 9999;
    const cdpClient = makeCDPClient(newBackendNodeId);

    const result = await manager.tryRelocateRef(sessionId, tabId, refId, page as any, cdpClient);

    expect(result).not.toBeNull();
    expect(result!.backendNodeId).toBe(newBackendNodeId);
    expect(result!.newRef).toMatch(/^ref_/);
  });

  test('returns new backendNodeId when element is re-found by name (aria-label)', async () => {
    const refId = manager.generateRef(sessionId, tabId, 200, 'textbox', 'Email address', 'input', undefined);
    const page = makePage(1); // evaluate returns 1 = found
    const newBackendNodeId = 8888;
    const cdpClient = makeCDPClient(newBackendNodeId);

    const result = await manager.tryRelocateRef(sessionId, tabId, refId, page as any, cdpClient);

    expect(result).not.toBeNull();
    expect(result!.backendNodeId).toBe(newBackendNodeId);
    expect(result!.newRef).toMatch(/^ref_/);
  });

  test('returns null when Runtime.evaluate finds element but DOM.describeNode fails', async () => {
    const refId = manager.generateRef(sessionId, tabId, 300, 'button', 'Go', 'button', 'Go');
    const page = makePage(1);
    // CDP client where Runtime.evaluate succeeds but DOM.describeNode returns no backendNodeId
    const cdpClient = {
      send: jest.fn().mockImplementation(async (_page: unknown, method: string) => {
        if (method === 'Runtime.evaluate') {
          return { result: { objectId: 'obj-x' } };
        }
        if (method === 'DOM.describeNode') {
          return { node: { backendNodeId: 0 } }; // invalid = falsy
        }
        return {};
      }),
    };

    const result = await manager.tryRelocateRef(sessionId, tabId, refId, page as any, cdpClient);
    expect(result).toBeNull();
  });

  test('returns null when evaluate throws', async () => {
    const refId = manager.generateRef(sessionId, tabId, 400, 'button', 'OK', 'button', 'OK');
    const page = createMockPage();
    (page.evaluate as jest.Mock).mockRejectedValue(new Error('CDP evaluate failed'));
    const cdpClient = makeCDPClient(null);

    const result = await manager.tryRelocateRef(sessionId, tabId, refId, page as any, cdpClient);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Integration tests: computer tool recovers from stale ref
// ---------------------------------------------------------------------------
describe('computer tool stale ref auto-recovery', () => {
  let mockSessionManager: ReturnType<typeof createMockSessionManager>;
  let mockRefIdManager: ReturnType<typeof createMockRefIdManager>;
  let testSessionId: string;
  let testTargetId: string;

  const getComputerHandler = async () => {
    jest.resetModules();
    jest.doMock('../../src/session-manager', () => ({
      getSessionManager: () => mockSessionManager,
    }));
    jest.doMock('../../src/utils/ref-id-manager', () => ({
      getRefIdManager: () => mockRefIdManager,
    }));
    const { registerComputerTool } = await import('../../src/tools/computer');
    const tools: Map<string, { handler: (sessionId: string, args: Record<string, unknown>) => Promise<unknown> }> = new Map();
    const mockServer = {
      registerTool: (name: string, handler: unknown) => {
        tools.set(name, { handler: handler as (sessionId: string, args: Record<string, unknown>) => Promise<unknown> });
      },
    };
    registerComputerTool(mockServer as unknown as Parameters<typeof registerComputerTool>[0]);
    return tools.get('computer')!.handler;
  };

  beforeEach(async () => {
    mockSessionManager = createMockSessionManager();
    mockRefIdManager = createMockRefIdManager();
    (getSessionManager as jest.Mock).mockReturnValue(mockSessionManager);
    (getRefIdManager as jest.Mock).mockReturnValue(mockRefIdManager);

    testSessionId = 'test-session-recovery';
    const { targetId } = await mockSessionManager.createTarget(testSessionId, 'about:blank');
    testTargetId = targetId;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test('recovers transparently when ref is stale and element is re-located', async () => {
    const handler = await getComputerHandler();

    const refId = mockRefIdManager.generateRef(testSessionId, testTargetId, 12345, 'button', 'Submit', 'button', 'Submit');

    // DOM.describeNode returns a different tag (div) -> triggers stale detection
    // tryRelocateRef returns a new node
    mockSessionManager.mockCDPClient.send
      .mockResolvedValueOnce({ node: { localName: 'div' } })  // DOM.describeNode (stale check - tag changed)
      // tryRelocateRef inner CDP calls handled by tryRelocateRef mock
      .mockResolvedValueOnce({})  // DOM.scrollIntoViewIfNeeded
      .mockResolvedValueOnce({ model: { content: [100, 100, 200, 100, 200, 200, 100, 200] } }); // DOM.getBoxModel

    // validateRef returns stale
    mockRefIdManager.validateRef.mockReturnValue({ valid: false, stale: true, reason: 'Element tag changed: expected <button>, found <div>' });

    // tryRelocateRef succeeds with a new node
    mockRefIdManager.tryRelocateRef.mockResolvedValue({ backendNodeId: 99999, newRef: 'ref_2' });

    const page = mockSessionManager.pages.get(testTargetId)!;
    (page.evaluate as jest.Mock).mockResolvedValue(null); // withDomDelta + generateVisualSummary

    const result = await handler(testSessionId, {
      tabId: testTargetId,
      action: 'left_click',
      ref: refId,
    }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

    expect(result.isError).toBeUndefined();
    expect(mockRefIdManager.tryRelocateRef).toHaveBeenCalledWith(
      testSessionId, testTargetId, refId, expect.anything(), expect.anything()
    );
  });

  test('returns error when ref is stale and element cannot be re-located', async () => {
    const handler = await getComputerHandler();

    const refId = mockRefIdManager.generateRef(testSessionId, testTargetId, 12345, 'button', 'Gone', 'button', 'Gone');

    mockSessionManager.mockCDPClient.send
      .mockResolvedValueOnce({ node: { localName: 'div' } }); // DOM.describeNode (stale check)

    mockRefIdManager.validateRef.mockReturnValue({ valid: false, stale: true, reason: 'Element tag changed: expected <button>, found <div>' });

    // tryRelocateRef fails
    mockRefIdManager.tryRelocateRef.mockResolvedValue(null);

    const result = await handler(testSessionId, {
      tabId: testTargetId,
      action: 'left_click',
      ref: refId,
    }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('stale');
    expect(result.content[0].text).toContain('re-located');
  });
});

// ---------------------------------------------------------------------------
// Integration tests: form_input tool recovers from stale ref
// ---------------------------------------------------------------------------
describe('form_input tool stale ref auto-recovery', () => {
  let mockSessionManager: ReturnType<typeof createMockSessionManager>;
  let mockRefIdManager: ReturnType<typeof createMockRefIdManager>;
  let testSessionId: string;
  let testTargetId: string;

  const getFormInputHandler = async () => {
    jest.resetModules();
    jest.doMock('../../src/session-manager', () => ({
      getSessionManager: () => mockSessionManager,
    }));
    jest.doMock('../../src/utils/ref-id-manager', () => ({
      getRefIdManager: () => mockRefIdManager,
    }));
    const { registerFormInputTool } = await import('../../src/tools/form-input');
    const tools: Map<string, { handler: (sessionId: string, args: Record<string, unknown>) => Promise<unknown> }> = new Map();
    const mockServer = {
      registerTool: (name: string, handler: unknown) => {
        tools.set(name, { handler: handler as (sessionId: string, args: Record<string, unknown>) => Promise<unknown> });
      },
    };
    registerFormInputTool(mockServer as unknown as Parameters<typeof registerFormInputTool>[0]);
    return tools.get('form_input')!.handler;
  };

  beforeEach(async () => {
    mockSessionManager = createMockSessionManager();
    mockRefIdManager = createMockRefIdManager();
    (getSessionManager as jest.Mock).mockReturnValue(mockSessionManager);
    (getRefIdManager as jest.Mock).mockReturnValue(mockRefIdManager);

    testSessionId = 'test-session-fi-recovery';
    const { targetId } = await mockSessionManager.createTarget(testSessionId, 'about:blank');
    testTargetId = targetId;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test('recovers transparently when ref is stale and element is re-located', async () => {
    const handler = await getFormInputHandler();

    const refId = mockRefIdManager.generateRef(testSessionId, testTargetId, 55555, 'textbox', 'Email', 'input', undefined);

    // DOM.describeNode (stale check) -> tag changed
    // DOM.resolveNode (after recovery) -> success
    // Runtime.callFunctionOn (element info) -> input type text
    // DOM.focus, Input.dispatchKeyEvent x2, Input.insertText (CDP native input)
    mockSessionManager.mockCDPClient.send
      .mockResolvedValueOnce({ node: { localName: 'div' } }) // DOM.describeNode for stale check
      .mockResolvedValueOnce({ object: { objectId: 'obj-recovered' } }) // DOM.resolveNode with recovered backendNodeId
      .mockResolvedValueOnce({ result: { value: { tagName: 'input', type: 'text', disabled: false, readOnly: false, contentEditable: false } } }) // element info
      .mockResolvedValueOnce({}) // DOM.focus
      .mockResolvedValueOnce({}) // Input.dispatchKeyEvent keyDown
      .mockResolvedValueOnce({}) // Input.dispatchKeyEvent keyUp
      .mockResolvedValueOnce({}); // Input.insertText

    mockRefIdManager.validateRef.mockReturnValue({ valid: false, stale: true, reason: 'Element tag changed: expected <input>, found <div>' });

    // tryRelocateRef succeeds
    mockRefIdManager.tryRelocateRef.mockResolvedValue({ backendNodeId: 77777, newRef: 'ref_2' });

    const page = mockSessionManager.pages.get(testTargetId)!;
    (page.evaluate as jest.Mock).mockResolvedValue(null); // withDomDelta

    const result = await handler(testSessionId, {
      tabId: testTargetId,
      ref: refId,
      value: 'test@example.com',
    }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

    expect(result.isError).toBeUndefined();
    expect(mockRefIdManager.tryRelocateRef).toHaveBeenCalledWith(
      testSessionId, testTargetId, refId, expect.anything(), expect.anything()
    );
  });

  test('returns error when ref is stale and element cannot be re-located', async () => {
    const handler = await getFormInputHandler();

    const refId = mockRefIdManager.generateRef(testSessionId, testTargetId, 55555, 'textbox', 'Gone', 'input', undefined);

    mockSessionManager.mockCDPClient.send
      .mockResolvedValueOnce({ node: { localName: 'div' } }); // DOM.describeNode (stale check)

    mockRefIdManager.validateRef.mockReturnValue({ valid: false, stale: true, reason: 'Element tag changed: expected <input>, found <div>' });
    mockRefIdManager.tryRelocateRef.mockResolvedValue(null);

    const result = await handler(testSessionId, {
      tabId: testTargetId,
      ref: refId,
      value: 'anything',
    }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('stale');
    expect(result.content[0].text).toContain('re-located');
  });
});
