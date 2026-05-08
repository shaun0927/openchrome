/**
 * CLI smoke tests for `oc trace` and `oc skill` (M1 PR-3).
 *
 * Spawns the compiled CLI against an isolated trace/skill root populated
 * by the in-process storage classes. Exercises:
 *   - oc trace list (empty, with rows, JSON mode, --status filter)
 *   - oc trace show <id> (text + JSON)
 *   - oc skill list / skill inspect (JSON mode is most stable to assert on)
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { TraceStorage } from '../../src/trace/storage';
import { SkillGraphStorage } from '../../src/skill/storage';

const CLI_ENTRY = path.resolve(__dirname, '..', '..', 'dist', 'cli', 'index.js');

function runCli(
  args: string[],
  env: NodeJS.ProcessEnv = {},
): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 15_000,
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

beforeAll(() => {
  if (!fs.existsSync(CLI_ENTRY)) {
    throw new Error(
      `CLI build artifact missing at ${CLI_ENTRY}. Run \`npm run build\` before this test suite.`,
    );
  }
});

describe('oc trace — list / show', () => {
  let traceRoot: string;
  let store: TraceStorage;

  beforeEach(() => {
    traceRoot = tempDir('oc-cli-trace-');
    store = new TraceStorage({ rootDir: traceRoot });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(traceRoot, { recursive: true, force: true });
  });

  test('list against an empty index reports "No traces matched"', () => {
    const r = runCli(['trace', 'list'], { OPENCHROME_TRACE_ROOT: traceRoot });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('No traces matched');
  });

  test('list returns rows after recording sessions', () => {
    store.recordSessionStart({
      sessionId: 's-completed',
      startedAt: 1000,
      domain: 'amazon.com',
      status: 'completed',
    });
    store.recordSessionStart({
      sessionId: 's-failed',
      startedAt: 2000,
      domain: 'github.com',
      status: 'failed',
    });

    const r = runCli(['trace', 'list', '--json'], { OPENCHROME_TRACE_ROOT: traceRoot });
    expect(r.code).toBe(0);
    const rows = JSON.parse(r.stdout) as Array<{ session_id: string; status: string }>;
    expect(rows.map((row) => row.session_id).sort()).toEqual(['s-completed', 's-failed']);
  });

  test('--status filter narrows the result set', () => {
    store.recordSessionStart({ sessionId: 'a', startedAt: 100, status: 'completed' });
    store.recordSessionStart({ sessionId: 'b', startedAt: 200, status: 'failed' });
    const r = runCli(['trace', 'list', '--status', 'failed', '--json'], {
      OPENCHROME_TRACE_ROOT: traceRoot,
    });
    expect(r.code).toBe(0);
    const rows = JSON.parse(r.stdout) as Array<{ session_id: string }>;
    expect(rows.map((row) => row.session_id)).toEqual(['b']);
  });

  test('show <id> prints metadata + recorded events (JSON mode)', () => {
    store.recordSessionStart({
      sessionId: 's1',
      startedAt: 1000,
      domain: 'amazon.com',
      status: 'completed',
    });
    store.appendEvents('s1', [
      { ts: 1010, seq: 1, kind: 'Page.frameNavigated', body: { url: 'https://a' } },
      { ts: 1020, seq: 2, kind: 'Network.responseReceived', body: { status: 200 } },
    ]);

    const r = runCli(['trace', 'show', 's1', '--json'], {
      OPENCHROME_TRACE_ROOT: traceRoot,
    });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout) as { meta: { session_id: string }; events: unknown[]; totalEvents: number };
    expect(out.meta.session_id).toBe('s1');
    expect(out.totalEvents).toBe(2);
    expect(out.events).toHaveLength(2);
  });

  test('show <unknown-id> exits non-zero with error message', () => {
    const r = runCli(['trace', 'show', 'nope'], { OPENCHROME_TRACE_ROOT: traceRoot });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('No trace found');
  });

  test('list renders "0 B" for a freshly-started session (no NaN/undefined)', () => {
    // recordSessionStart leaves byte_size at the schema default; this row is
    // representative of any active or empty trace. Regression: fmtBytes used
    // to render `Math.log(n)` for non-positive `n`, producing "NaN undefined".
    store.recordSessionStart({
      sessionId: 's-empty',
      startedAt: 1000,
      domain: 'example.com',
      status: 'running',
    });
    const r = runCli(['trace', 'list'], { OPENCHROME_TRACE_ROOT: traceRoot });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('0 B');
    expect(r.stdout).not.toMatch(/NaN|undefined/);
  });

  test('list does not truncate UUID-length session ids in table output', () => {
    // Regression: the SESSION column was previously sliced to 22 chars,
    // making it impossible to copy a UUID id back into `oc trace show`.
    const fullId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    store.recordSessionStart({
      sessionId: fullId,
      startedAt: 1000,
      domain: 'x.com',
      status: 'completed',
    });
    const r = runCli(['trace', 'list'], { OPENCHROME_TRACE_ROOT: traceRoot });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(fullId);
  });

  test('show orders chunk files numerically by (ts, seq), not lexically', () => {
    // Recorder names chunk files `<ts>-<seq>.jsonl`. A plain lexical
    // `.sort()` placed `...-10.jsonl` before `...-2.jsonl`, so when two
    // flushes shared a millisecond the second flush's events appeared
    // before the first. Plant chunks out of lexical order and verify
    // `--limit` returns the latest events as defined by (ts, seq).
    store.recordSessionStart({ sessionId: 's-chunks', startedAt: 1, status: 'completed' });
    const sessionDir = path.join(traceRoot, 's-chunks');
    fs.mkdirSync(sessionDir, { recursive: true });
    // Two chunks at the same timestamp, seq=2 then seq=10.
    fs.writeFileSync(
      path.join(sessionDir, '1730000000000-2.jsonl'),
      JSON.stringify({ ts: 100, seq: 2, kind: 'EARLIER', body: {} }) + '\n',
    );
    fs.writeFileSync(
      path.join(sessionDir, '1730000000000-10.jsonl'),
      JSON.stringify({ ts: 200, seq: 10, kind: 'LATER', body: {} }) + '\n',
    );

    const r = runCli(['trace', 'show', 's-chunks', '--limit', '1', '--json'], {
      OPENCHROME_TRACE_ROOT: traceRoot,
    });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout) as { events: Array<{ kind: string }> };
    expect(out.events).toHaveLength(1);
    expect(out.events[0].kind).toBe('LATER');
  });

  test('show --limit returns the most recent events, not the oldest', () => {
    // Regression: the prior `slice(0, limit)` returned the *oldest*
    // events while help advertised "recent events"; for a long session
    // the failure trigger (always near the end) was hidden by default.
    store.recordSessionStart({ sessionId: 's-many', startedAt: 1, status: 'completed' });
    const events = Array.from({ length: 10 }, (_, i) => ({
      ts: 100 + i,
      seq: i + 1,
      kind: i === 9 ? 'Final' : `K${i}`,
      body: { i },
    }));
    store.appendEvents('s-many', events);

    const r = runCli(['trace', 'show', 's-many', '--limit', '3', '--json'], {
      OPENCHROME_TRACE_ROOT: traceRoot,
    });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout) as {
      events: Array<{ kind: string; seq: number }>;
      totalEvents: number;
      omitted: number;
    };
    expect(out.totalEvents).toBe(10);
    expect(out.omitted).toBe(7);
    expect(out.events.map((e) => e.kind)).toEqual(['K7', 'K8', 'Final']);
  });
});

describe('oc skill — list / inspect', () => {
  let skillRoot: string;
  let store: SkillGraphStorage;

  beforeEach(() => {
    skillRoot = tempDir('oc-cli-skill-');
    store = new SkillGraphStorage('amazon.com', { rootDir: skillRoot });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(skillRoot, { recursive: true, force: true });
  });

  test('list reports the per-domain DBs in the root', () => {
    const r = runCli(['skill', 'list', '--json'], { OPENCHROME_SKILL_ROOT: skillRoot });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(['amazon.com']);
  });

  test('inspect <unknown-domain> exits non-zero', () => {
    const r = runCli(['skill', 'inspect', 'unknown.example'], {
      OPENCHROME_SKILL_ROOT: skillRoot,
    });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('No skill graph');
  });

  test('inspect <domain> reports node/edge counts (JSON mode)', () => {
    store.upsertNode({ stateHash: 'hash-a' });
    store.upsertNode({ stateHash: 'hash-b' });
    store.recordOutcome({
      fromState: 'hash-a',
      actionKind: 'click',
      actionArgsNorm: 'ref:1',
      observedToState: 'hash-b',
      success: true,
    });

    const r = runCli(['skill', 'inspect', 'amazon.com', '--json'], {
      OPENCHROME_SKILL_ROOT: skillRoot,
    });
    expect(r.code).toBe(0);
    const summary = JSON.parse(r.stdout) as {
      domain: string;
      nodeCount: number;
      edgeCount: number;
      topEdges: Array<{ actionKind: string; successCount: number; failCount: number }>;
    };
    expect(summary.domain).toBe('amazon.com');
    expect(summary.nodeCount).toBe(2);
    expect(summary.edgeCount).toBe(1);
    expect(summary.topEdges).toHaveLength(1);
    expect(summary.topEdges[0].successCount).toBe(1);
  });

  test('inspect rejects path-traversal domain arguments', () => {
    // A traversing domain must be refused before `path.join` builds a path
    // that escapes OPENCHROME_SKILL_ROOT. Storage's constructor validates
    // the same way (`/[\\/]/`), and the CLI must stay consistent.
    for (const bad of ['../foo', '..\\foo', '/etc/passwd', '..']) {
      const r = runCli(['skill', 'inspect', bad], { OPENCHROME_SKILL_ROOT: skillRoot });
      expect(r.code).not.toBe(0);
      expect(r.stderr).toMatch(/Invalid domain/);
    }
  });
});
