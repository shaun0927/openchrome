import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { RecoveryTrajectoryLedger, summarizeArgs, summarizeResult } from '../../src/recovery';

describe('RecoveryTrajectoryLedger', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-recovery-ledger-'));
  });

  afterEach(() => {
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
      nested: { apiKey: 'key-123', visible: 'ok' },
    });

    expect(args).toMatchObject({
      username: 'alice',
      password: '[REDACTED]',
      authorization: '[REDACTED]',
      nested: { apiKey: '[REDACTED]', visible: 'ok' },
    });
    expect(String(args?.html)).toMatch(/^sha256:/);
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

  it('returns null instead of throwing when writes fail', () => {
    const filePath = path.join(dir, 'not-a-dir');
    fs.writeFileSync(filePath, 'block mkdir');
    const ledger = new RecoveryTrajectoryLedger({ dirPath: filePath });

    expect(ledger.record({ sessionId: 's1', toolName: 'read_page', resultStatus: 'success' })).toBeNull();
  });
});
