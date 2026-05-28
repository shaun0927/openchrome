/**
 * Tests for the image_qa MCP tool (#1432 Part 1).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { MCPServer } from '../../src/mcp-server';
import { registerImageQaTool } from '../../src/tools/image-qa';
import type { ToolContext } from '../../src/types/mcp';

function getRegisteredTool(server: MCPServer, name: string) {
  // MCPServer keeps a registry; reach in via the internal map for tests.
  // The repo's other tool tests use the public registerTool surface and
  // then invoke the registered handler through the registry getter when
  // exposed. Fall back to capturing the handler during registration if no
  // public getter exists.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const reg = (server as any).tools as Map<string, { handler: Function; definition: unknown }> | undefined;
  if (!reg) throw new Error('MCPServer has no `tools` map exposed for test introspection');
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

describe('image_qa MCP tool (#1432)', () => {
  let server: MCPServer;
  let tmpDir: string;

  beforeAll(() => {
    server = new MCPServer();
    registerImageQaTool(server);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-qa-test-'));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function callImageQa(args: Record<string, unknown>, ctx?: Partial<ToolContext>) {
    const tool = getRegisteredTool(server, 'image_qa');
    const fullCtx: ToolContext = {
      startTime: Date.now(),
      deadlineMs: 60_000,
      ...(ctx ?? {}),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (tool.handler as any)('test-session', args, fullCtx);
  }

  it('returns unsupported_by_host when the client lacks sampling capability', async () => {
    const res = await callImageQa({
      screenshot: { base64: 'AAAA' },
      question: 'what is on the page?',
    });
    const parsed = parseResult(res);
    expect(parsed.status).toBe('unsupported_by_host');
  });

  it('rejects when neither base64, path, nor ref is provided', async () => {
    const res = await callImageQa({
      screenshot: {},
      question: 'q',
    });
    const parsed = parseResult(res);
    expect(parsed.status).toBe('error');
    expect(parsed.reason).toMatch(/exactly one of/);
  });

  it('rejects when both base64 and path are provided', async () => {
    const res = await callImageQa({
      screenshot: { base64: 'AAAA', path: '/tmp/x.png' },
      question: 'q',
    });
    const parsed = parseResult(res);
    expect(parsed.status).toBe('error');
    expect(parsed.reason).toMatch(/exactly one of/);
  });

  it('rejects when question is missing', async () => {
    const res = await callImageQa({
      screenshot: { base64: 'AAAA' },
    });
    const parsed = parseResult(res);
    expect(parsed.status).toBe('error');
    expect(parsed.reason).toMatch(/question/);
  });

  it('forwards to sampling/createMessage when the client advertises sampling', async () => {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fakeRequestClient = async (method: string, params?: Record<string, unknown>): Promise<any> => {
      calls.push({ method, params });
      return { content: { type: 'text', text: 'the page shows a login form' }, model: 'host-vision-1' };
    };
    const res = await callImageQa(
      { screenshot: { base64: 'BBBB', mime_type: 'image/jpeg' }, question: 'what is on the page?' },
      { clientCapabilities: { sampling: {} }, requestClient: fakeRequestClient },
    );
    const parsed = parseResult(res);
    expect(parsed.status).toBe('ok');
    expect(parsed.answer).toBe('the page shows a login form');
    expect(parsed.model).toBe('host-vision-1');
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('sampling/createMessage');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const messages = (calls[0].params as any).messages;
    expect(messages[0].content[0].type).toBe('image');
    expect(messages[0].content[0].data).toBe('BBBB');
    expect(messages[0].content[0].mimeType).toBe('image/jpeg');
  });

  it('reads bytes from screenshot.path when sampling is available', async () => {
    const file = path.join(tmpDir, 'shot.png');
    fs.writeFileSync(file, Buffer.from([0xde, 0xad, 0xbe, 0xef]));
    let receivedBase64: string | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fakeRequestClient = async (_method: string, params?: Record<string, unknown>): Promise<any> => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const messages = (params as any).messages;
      receivedBase64 = messages[0].content[0].data as string;
      return { content: { type: 'text', text: 'ok' } };
    };
    const res = await callImageQa(
      { screenshot: { path: file }, question: 'q' },
      { clientCapabilities: { sampling: {} }, requestClient: fakeRequestClient },
    );
    const parsed = parseResult(res);
    expect(parsed.status).toBe('ok');
    expect(receivedBase64).toBe(Buffer.from([0xde, 0xad, 0xbe, 0xef]).toString('base64'));
  });
});
