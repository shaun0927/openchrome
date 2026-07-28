/// <reference types="jest" />

import fs from 'node:fs';
import path from 'node:path';
import type { MCPToolDefinition, ToolContext } from '../../src/types/mcp';
import { TOOL_ANNOTATIONS } from '../../src/types/tool-annotations';
import { createMockSessionManager } from '../utils/mock-session';

jest.mock('../../src/session-manager', () => ({
  getSessionManager: jest.fn(),
}));

import { getSessionManager } from '../../src/session-manager';
import {
  BrowserActivationCoordinator,
  activatePageWithVerification,
  registerTabsActivateTool,
  resetTabsActivationCoordinatorForTesting,
} from '../../src/tools/tabs-activate';

type RegisteredTool = {
  handler: (sessionId: string, args: Record<string, unknown>, context?: ToolContext) => Promise<unknown>;
  definition: MCPToolDefinition;
};

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((innerResolve) => { resolve = innerResolve; });
  return { promise, resolve };
}

function context(deadlineMs = 2000): ToolContext {
  return { startTime: Date.now(), deadlineMs };
}

function registeredTool(): RegisteredTool {
  const tools = new Map<string, RegisteredTool>();
  const server = {
    registerTool: (name: string, handler: RegisteredTool['handler'], definition: MCPToolDefinition) => {
      tools.set(name, { handler, definition });
    },
  };
  registerTabsActivateTool(server as never);
  return tools.get('tabs_activate')!;
}

describe('tabs_activate', () => {
  beforeEach(() => {
    resetTabsActivationCoordinatorForTesting();
    jest.clearAllMocks();
  });

  test('registers a full-surface-only mutating CDP tool schema', () => {
    const { definition } = registeredTool();

    expect(definition.name).toBe('tabs_activate');
    expect(definition.annotations).toEqual(TOOL_ANNOTATIONS.tabs_activate);
    expect(definition.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
    expect(definition.inputSchema.properties.windowForeground).toMatchObject({
      enum: ['cdp-only'],
    });
    expect(definition.outputSchema?.required).toEqual(expect.arrayContaining([
      'tabId',
      'activated',
      'outcome',
      'visibilityState',
      'documentFocused',
      'attempts',
      'windowForegroundAttempted',
      'pathTaken',
      'superseded',
      'requestSequence',
    ]));
  });

  test('uses Target.activateTarget and treats visible plus unfocused as verified in cdp-only mode', async () => {
    const manager = createMockSessionManager();
    (getSessionManager as jest.Mock).mockReturnValue(manager);
    const { targetId, page } = await manager.createTarget('session-a', 'https://example.com', 'worker-a');
    (page.evaluate as jest.Mock).mockResolvedValue({
      visibilityState: 'visible',
      documentFocused: false,
    });
    const cdpSession = await page.target().createCDPSession();

    const result = await registeredTool().handler(
      'session-a',
      { tabId: targetId, workerId: 'worker-a' },
      context(),
    ) as { content: Array<{ text: string }>; structuredContent: Record<string, unknown> };
    const payload = JSON.parse(result.content[0].text);

    expect(payload).toEqual(result.structuredContent);
    expect(payload).toMatchObject({
      tabId: targetId,
      activated: true,
      outcome: 'verified',
      visibilityState: 'visible',
      documentFocused: false,
      attempts: 1,
      windowForegroundAttempted: false,
      pathTaken: 'Target.activateTarget',
      superseded: false,
      requestSequence: 1,
    });
    expect(cdpSession.send).toHaveBeenCalledWith('Target.activateTarget', { targetId });
    expect(manager.getPage).toHaveBeenCalledWith('session-a', targetId, 'worker-a', 'tabs_activate');
    expect(manager.runTargetExclusive).toHaveBeenCalledWith('session-a', targetId, expect.any(Function));
  });

  test('retries hidden documents and reports the final visibility/focus facts', async () => {
    const manager = createMockSessionManager();
    const { targetId, page } = await manager.createTarget('session-a', 'https://example.com');
    (page.evaluate as jest.Mock)
      .mockResolvedValueOnce({ visibilityState: 'hidden', documentFocused: false })
      .mockResolvedValueOnce({ visibilityState: 'visible', documentFocused: true });

    const result = await activatePageWithVerification({
      page,
      tabId: targetId,
      context: context(),
      sleep: async () => undefined,
    });

    expect(result).toMatchObject({
      activated: true,
      outcome: 'verified',
      visibilityState: 'visible',
      documentFocused: true,
      attempts: 2,
    });
    const cdpSession = await page.target().createCDPSession();
    expect(cdpSession.send).toHaveBeenCalledTimes(2);
  });

  test('returns bounded inconclusive facts when visibility evaluation keeps failing', async () => {
    const manager = createMockSessionManager();
    const { targetId, page } = await manager.createTarget('session-a', 'https://example.com');
    (page.evaluate as jest.Mock).mockRejectedValue(new Error('execution context unavailable'));

    const result = await activatePageWithVerification({
      page,
      tabId: targetId,
      context: context(),
      sleep: async () => undefined,
    });

    expect(result).toMatchObject({
      activated: false,
      outcome: 'inconclusive',
      visibilityState: 'unknown',
      documentFocused: false,
      attempts: 3,
      activationSent: true,
    });
    expect(result.verificationError).toContain('execution context unavailable');
  });

  test('bounds a stalled verification by the normal tool deadline', async () => {
    const manager = createMockSessionManager();
    const { targetId, page } = await manager.createTarget('session-a', 'https://example.com');
    (page.evaluate as jest.Mock).mockReturnValue(new Promise(() => undefined));

    const result = await activatePageWithVerification({
      page,
      tabId: targetId,
      context: context(25),
      sleep: async () => undefined,
    });

    expect(result.outcome).toBe('inconclusive');
    expect(result.activated).toBe(false);
    expect(result.attempts).toBe(1);
    expect(result.verificationError).toMatch(/deadline|timed out/i);
  });

  test('returns structured inconclusive facts when CDP session creation is unavailable', async () => {
    const manager = createMockSessionManager();
    const { targetId, page } = await manager.createTarget('session-a', 'https://example.com');
    (page.target().createCDPSession as jest.Mock).mockRejectedValueOnce(new Error('CDP session unavailable'));

    const result = await activatePageWithVerification({
      page,
      tabId: targetId,
      context: context(),
      sleep: async () => undefined,
    });

    expect(result).toMatchObject({
      tabId: targetId,
      activated: false,
      outcome: 'inconclusive',
      attempts: 0,
      activationSent: false,
      visibilityState: 'unknown',
      documentFocused: false,
      verificationError: 'CDP session unavailable',
    });
  });

  test('does not send a delayed activation after the tool deadline has expired', async () => {
    const manager = createMockSessionManager();
    const { targetId, page } = await manager.createTarget('session-a', 'https://example.com');
    const cdpSession = await page.target().createCDPSession();

    const result = await activatePageWithVerification({
      page,
      tabId: targetId,
      context: { startTime: Date.now() - 100, deadlineMs: 10 },
      sleep: async () => undefined,
    });

    expect(result).toMatchObject({
      activated: false,
      outcome: 'inconclusive',
      attempts: 0,
      activationSent: false,
    });
    expect(result.verificationError).toMatch(/deadline|timed out/i);
    expect(cdpSession.send).not.toHaveBeenCalledWith('Target.activateTarget', expect.anything());
  });

  test('rejects cross-session ownership before sending an activation command', async () => {
    const manager = createMockSessionManager();
    (getSessionManager as jest.Mock).mockReturnValue(manager);
    const { targetId, page } = await manager.createTarget('owner-session', 'https://example.com');
    const cdpSession = await page.target().createCDPSession();

    const result = await registeredTool().handler('other-session', { tabId: targetId }, context()) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('does not belong to session');
    expect(cdpSession.send).not.toHaveBeenCalledWith('Target.activateTarget', expect.anything());
  });

  test('rejects cross-worker ownership before sending an activation command', async () => {
    const manager = createMockSessionManager();
    (getSessionManager as jest.Mock).mockReturnValue(manager);
    const { targetId, page } = await manager.createTarget('session-a', 'https://example.com', 'worker-a');
    const cdpSession = await page.target().createCDPSession();

    const result = await registeredTool().handler(
      'session-a',
      { tabId: targetId, workerId: 'worker-b' },
      context(),
    ) as { content: Array<{ text: string }>; isError?: boolean };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('does not belong to worker worker-b');
    expect(cdpSession.send).not.toHaveBeenCalledWith('Target.activateTarget', expect.anything());
  });

  test('executes browser activation requests in FIFO order and marks overtaken work as superseded', async () => {
    const coordinator = new BrowserActivationCoordinator();
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    const calls: string[] = [];

    const first = coordinator.enqueue(async () => {
      calls.push('first:start');
      firstStarted.resolve();
      await releaseFirst.promise;
      calls.push('first:end');
      return 'first';
    });
    await firstStarted.promise;

    const second = coordinator.enqueue(async () => {
      calls.push('second');
      return 'second';
    });
    const third = coordinator.enqueue(async () => {
      calls.push('third');
      return 'third';
    });
    releaseFirst.resolve();

    await expect(first).resolves.toMatchObject({
      superseded: true,
      sequence: 1,
      value: 'first',
    });
    await expect(second).resolves.toMatchObject({
      superseded: true,
      sequence: 2,
      value: 'second',
    });
    await expect(third).resolves.toMatchObject({
      superseded: false,
      sequence: 3,
      value: 'third',
    });
    expect(calls).toEqual(['first:start', 'first:end', 'second', 'third']);
  });

  test('does not add implicit activation to existing browser tools', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    for (const relative of [
      'src/tools/navigate.ts',
      'src/tools/read-page.ts',
      'src/tools/interact.ts',
      'src/tools/batch-execute.ts',
    ]) {
      const source = fs.readFileSync(path.join(repoRoot, relative), 'utf8');
      expect(source).not.toContain('Target.activateTarget');
      expect(source).not.toContain("'tabs_activate'");
    }
  });
});
