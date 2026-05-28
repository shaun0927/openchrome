/**
 * Runtime wire-up test for oc_assert + image_qa (#1432 Part 2 follow-up).
 *
 * Exercises the full path: an oc_assert call with an `image_qa`
 * contract clause must thread through the runtime's `imageQaSample`
 * hook to the host's MCP sampling capability, evaluate the regex
 * match, and return a verdict.
 */
import { MCPServer } from '../../src/mcp-server';
import { registerOcAssertTool } from '../../src/tools/oc-assert';
import type { ToolContext } from '../../src/types/mcp';

function getRegisteredTool(server: MCPServer, name: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const reg = (server as any).tools as Map<string, { handler: Function }> | undefined;
  if (!reg) throw new Error('MCPServer has no tools map');
  const entry = reg.get(name);
  if (!entry) throw new Error(`tool not registered: ${name}`);
  return entry;
}

function parseResult(res: { content: Array<{ type: string; text?: string }> }) {
  const block = res.content[0];
  if (!block || block.type !== 'text' || typeof block.text !== 'string') {
    throw new Error('expected text result block');
  }
  return JSON.parse(block.text);
}

describe('oc_assert + image_qa runtime hook (#1432 Part 2 wire-up)', () => {
  let server: MCPServer;

  beforeAll(() => {
    server = new MCPServer();
    registerOcAssertTool(server);
  });

  function callAssert(args: Record<string, unknown>, ctx?: Partial<ToolContext>) {
    const tool = getRegisteredTool(server, 'oc_assert');
    const fullCtx: ToolContext = {
      startTime: Date.now(),
      deadlineMs: 60_000,
      ...(ctx ?? {}),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (tool.handler as any)('test-session', args, fullCtx);
  }

  const pngBase64 = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');

  it('passes when the host answer matches the expected_pattern', async () => {
    const fakeRequestClient = async (
      method: string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      _params?: Record<string, unknown>,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ): Promise<any> => {
      expect(method).toBe('sampling/createMessage');
      return { content: { type: 'text', text: 'yes, dark mode is on' } };
    };
    const res = await callAssert(
      {
        contract: { kind: 'image_qa', question: 'dark mode?', expected_pattern: '^yes' },
        evidence: { snapshot: { screenshot_png_base64: pngBase64 } },
      },
      { clientCapabilities: { sampling: {} }, requestClient: fakeRequestClient },
    );
    const parsed = parseResult(res);
    expect(parsed.verdict).toBe('pass');
  });

  it('fails when the host answer does not match the expected_pattern', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fakeRequestClient = async (): Promise<any> => ({
      content: { type: 'text', text: 'no, light mode is on' },
    });
    const res = await callAssert(
      {
        contract: { kind: 'image_qa', question: 'dark mode?', expected_pattern: '^yes' },
        evidence: { snapshot: { screenshot_png_base64: pngBase64 } },
      },
      { clientCapabilities: { sampling: {} }, requestClient: fakeRequestClient },
    );
    const parsed = parseResult(res);
    expect(parsed.verdict).toBe('fail');
  });

  it('returns inconclusive when the client has no sampling capability', async () => {
    const res = await callAssert(
      {
        contract: { kind: 'image_qa', question: 'dark mode?', expected_pattern: '.' },
        evidence: { snapshot: { screenshot_png_base64: pngBase64 } },
      },
      // No clientCapabilities, no requestClient.
    );
    const parsed = parseResult(res);
    expect(parsed.verdict).toBe('inconclusive');
  });

  it('returns inconclusive when no screenshot is supplied', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fakeRequestClient = async (): Promise<any> => ({
      content: { type: 'text', text: 'whatever' },
    });
    const res = await callAssert(
      {
        contract: { kind: 'image_qa', question: 'q', expected_pattern: '.' },
        evidence: { snapshot: { url: 'https://example.com/' } },
      },
      { clientCapabilities: { sampling: {} }, requestClient: fakeRequestClient },
    );
    const parsed = parseResult(res);
    expect(parsed.verdict).toBe('inconclusive');
  });

  it('returns inconclusive (not a vacuous pass) when the host returns a non-text content block', async () => {
    // A permissive pattern like '.' would match an empty answer, so a
    // non-text sampling response must degrade to inconclusive rather
    // than silently matching against ''.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fakeRequestClient = async (): Promise<any> => ({
      content: { type: 'image', data: 'AAAA' },
    });
    const res = await callAssert(
      {
        contract: { kind: 'image_qa', question: 'q', expected_pattern: '.' },
        evidence: { snapshot: { screenshot_png_base64: pngBase64 } },
      },
      { clientCapabilities: { sampling: {} }, requestClient: fakeRequestClient },
    );
    const parsed = parseResult(res);
    expect(parsed.verdict).toBe('inconclusive');
  });
});
