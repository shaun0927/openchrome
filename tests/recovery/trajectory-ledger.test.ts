import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { RecoveryTrajectoryLedger, summarizeArgs, summarizeResult } from '../../src/recovery';
import { EMPTY_SECRET_STORE, makeSecretStore, setSecretStore } from '../../src/core/secrets';

describe('RecoveryTrajectoryLedger', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-recovery-ledger-'));
  });

  afterEach(() => {
    setSecretStore(EMPTY_SECRET_STORE);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('records bounded success, error, and recovered nodes', () => {
    const ledger = new RecoveryTrajectoryLedger({ dirPath: dir, maxNodes: 10, maxNodeBytes: 2048 });

    const first = ledger.record({
      sessionId: 's1',
      toolName: 'click',
      args: { tabId: 'tab-1', ref: 'old' },
      resultStatus: 'error',
      error: 'Element ref is stale',
    });
    const second = ledger.record({
      sessionId: 's1',
      toolName: 'read_page',
      args: { tabId: 'tab-1' },
      parentNodeId: first?.nodeId,
      resultStatus: 'recovered',
      result: { content: [{ type: 'text', text: 'Fresh refs available' }] },
      recoveryTool: 'read_page',
    });

    expect(first?.failureFingerprint).toMatch(/^sha256:/);
    expect(second?.parentNodeId).toBe(first?.nodeId);

    const nodes = ledger.readRecent(10, 's1');
    expect(nodes).toHaveLength(2);
    expect(nodes[0].resultStatus).toBe('error');
    expect(nodes[1].resultStatus).toBe('recovered');
    expect(nodes[1].observationSummary).toContain('Fresh refs');
  });

  it('redacts sensitive args and hashes large payloads', () => {
    const args = summarizeArgs({
      username: 'alice',
      password: 'super-secret',
      authorization: 'Bearer token',
      html: '<html>' + 'x'.repeat(500) + '</html>',
      nested: { apiKey: 'key-123', accessToken: 'tok-123', sessionId: 'sid-123', authHeader: 'Bearer x', visible: 'ok' },
    });

    expect(args).toMatchObject({
      username: 'alice',
      password: '[REDACTED]',
      authorization: '[REDACTED]',
      nested: {
        apiKey: '[REDACTED]',
        accessToken: '[REDACTED]',
        sessionId: '[REDACTED]',
        authHeader: '[REDACTED]',
        visible: 'ok',
      },
    });
    expect(String(args?.html)).toMatch(/^sha256:/);
  });

  it('redacts secret values embedded in ordinary arg fields', () => {
    setSecretStore(makeSecretStore(new Map([['API_TOKEN', 'sk-live-ordinary-field']])));

    const args = summarizeArgs({
      note: 'retry with sk-live-ordinary-field',
      url: 'https://example.test/path?token=query-secret&ok=1',
      query: 'authorization: Bearer header-secret',
    });

    expect(args?.note).toBe('retry with ${SECRET:API_TOKEN}');
    expect(args?.url).toBe('https://example.test/path?token=[REDACTED]&ok=1');
    expect(args?.query).toBe('authorization: [REDACTED]');
  });

  it('summarizes result text without storing full content or obvious secrets', () => {
    const summary = summarizeResult({
      content: [{ type: 'text', text: 'hello\n'.repeat(200) + ' authorization: Bearer abc token=xyz cookie: sid=123' }],
    });

    expect(summary!.length).toBeLessThanOrEqual(501);
    expect(summary).toContain('hello');
    expect(summary).not.toContain('abc');
    expect(summary).not.toContain('sid=123');
  });

  it('enforces max node count', () => {
    const ledger = new RecoveryTrajectoryLedger({ dirPath: dir, maxNodes: 3, maxNodeBytes: 2048 });

    for (let i = 0; i < 8; i++) {
      ledger.record({ sessionId: 's1', toolName: `tool-${i}`, resultStatus: 'success' });
    }

    const nodes = ledger.readRecent(10, 's1');
    expect(nodes).toHaveLength(3);
    expect(nodes.map((n) => n.toolName)).toEqual(['tool-5', 'tool-6', 'tool-7']);
  });

  it('skips malformed persisted JSONL entries without hiding valid history', async () => {
    const ledger = new RecoveryTrajectoryLedger({ dirPath: dir, maxNodes: 10, maxNodeBytes: 2048 });
    const first = ledger.record({ sessionId: 's1', toolName: 'read_page', resultStatus: 'success' });
    await ledger.flush();
    fs.appendFileSync(ledger.getPath(), '{bad-json\n', 'utf8');
    const second = ledger.record({ sessionId: 's1', toolName: 'click', resultStatus: 'error' });

    const nodes = ledger.readRecent(10, 's1');
    expect(nodes.map((node) => node.nodeId)).toEqual([first!.nodeId, second!.nodeId]);
  });

  it('queues disk writes asynchronously while immediate reads include pending nodes', async () => {
    const ledger = new RecoveryTrajectoryLedger({ dirPath: dir, maxNodes: 10, maxNodeBytes: 2048 });

    const node = ledger.record({ sessionId: 's1', toolName: 'read_page', resultStatus: 'success' });

    expect(node).not.toBeNull();
    expect(ledger.readRecent(10, 's1').map((n) => n.nodeId)).toContain(node!.nodeId);

    await ledger.flush();

    const persisted = fs.readFileSync(ledger.getPath(), 'utf8');
    expect(persisted).toContain(node!.nodeId);
  });

  it('bounds the session parent index and prunes it after trimming', async () => {
    const ledger = new RecoveryTrajectoryLedger({ dirPath: dir, maxNodes: 3, maxNodeBytes: 2048 });

    for (let i = 0; i < 40; i++) {
      ledger.record({ sessionId: `s${i}`, toolName: `tool-${i}`, resultStatus: 'success' });
      expect((ledger as unknown as { lastNodeBySession: Map<string, string> }).lastNodeBySession.size).toBeLessThanOrEqual(16);
    }

    await ledger.flush();

    expect((ledger as unknown as { lastNodeBySession: Map<string, string> }).lastNodeBySession.size).toBeLessThanOrEqual(3);
    expect(ledger.readRecent(10).map((n) => n.sessionId)).toEqual(['s37', 's38', 's39']);
  });

  it('does not throw when queued writes fail', async () => {
    const filePath = path.join(dir, 'not-a-dir');
    fs.writeFileSync(filePath, 'block mkdir');
    const ledger = new RecoveryTrajectoryLedger({ dirPath: filePath });

    const node = ledger.record({ sessionId: 's1', toolName: 'read_page', resultStatus: 'success' });
    expect(node).not.toBeNull();
    expect(ledger.readRecent(10, 's1')).toHaveLength(1);

    await expect(ledger.flush()).resolves.toBeUndefined();
    expect(ledger.readRecent(10, 's1')).toHaveLength(0);
  });
});
