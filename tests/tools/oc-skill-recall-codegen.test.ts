/**
 * Tests for #1430 Part 2 — oc_skill_recall surfaces codegenArtifacts.
 *
 * Today the recall response shape is `RankedSkillRecord extends SkillRecord`,
 * so the field is forwarded automatically. These tests pin that behaviour:
 * if a future refactor reshapes the recall payload, the LLM-free fast path
 * documented in `docs/skills/llm-free-fast-path.md` would silently break.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { MCPServer } from '../../src/mcp-server';
import { registerOcSkillRecallTool } from '../../src/tools/oc-skill-recall';
import {
  SkillMemoryStore,
  type CodegenArtifactPointer,
  type SkillRecord,
} from '../../src/core/skill-memory';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oc-recall-codegen-'));
}

function getRegisteredTool(server: MCPServer, name: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const reg = (server as any).tools as Map<string, { handler: Function }> | undefined;
  if (!reg) throw new Error('MCPServer has no `tools` map exposed');
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

describe('oc_skill_recall — codegen artifact surfacing (#1430 Part 2)', () => {
  let root: string;
  let prevRoot: string | undefined;
  let server: MCPServer;

  beforeAll(() => {
    server = new MCPServer();
    registerOcSkillRecallTool(server);
  });

  beforeEach(() => {
    root = tempRoot();
    // Steer the store's default rootDir resolution via HOME override —
    // defaultSkillMemoryRootDir() = path.join(os.homedir(), '.openchrome',
    // 'skill-memory'), and os.homedir() reads $HOME on POSIX. The recall
    // handler constructs the store without rootDir, so both record and
    // recall see the same path through this single override.
    prevRoot = process.env.HOME;
    process.env.HOME = root;
  });

  afterEach(() => {
    if (prevRoot === undefined) delete process.env.HOME;
    else process.env.HOME = prevRoot;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('surfaces codegenArtifacts from the persisted record on recall', async () => {
    const artifacts: CodegenArtifactPointer[] = [
      { kind: 'playwright', path: 'sess-1/skill.spec.ts', created_at: 1700000000 },
      { kind: 'mcp-replay', path: 'sess-1/skill.jsonl', created_at: 1700000001 },
    ];
    const store = new SkillMemoryStore({ domain: 'amazon.com' });
    await store.record({
      domain: 'amazon.com',
      name: 'add-to-cart',
      steps: [{ kind: 'click', selector: '#buy-now' }],
      contractId: 'contract-1',
      successCount: 0,
      lastUsedAt: 0,
      frozenSnapshotPath: null,
      codegenArtifacts: artifacts,
    } as Omit<SkillRecord, 'skillId'>);

    const tool = getRegisteredTool(server, 'oc_skill_recall');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (tool.handler as any)('test-session', { domain: 'amazon.com' });
    const parsed = parseResult(res);
    expect(parsed.skills).toHaveLength(1);
    expect(parsed.skills[0].codegenArtifacts).toEqual(artifacts);
  });

  it('emits codegenArtifacts as an empty array when none were persisted', async () => {
    const store = new SkillMemoryStore({ domain: 'amazon.com' });
    await store.record({
      domain: 'amazon.com',
      name: 'add-to-cart',
      steps: [],
      contractId: 'contract-1',
      successCount: 0,
      lastUsedAt: 0,
      frozenSnapshotPath: null,
      codegenArtifacts: [],
    } as Omit<SkillRecord, 'skillId'>);

    const tool = getRegisteredTool(server, 'oc_skill_recall');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (tool.handler as any)('test-session', { domain: 'amazon.com' });
    const parsed = parseResult(res);
    expect(parsed.skills).toHaveLength(1);
    expect(parsed.skills[0].codegenArtifacts).toEqual([]);
  });
});
