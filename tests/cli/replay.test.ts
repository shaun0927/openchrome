/**
 * Tests for cli/replay.ts — subcommand wiring and exit codes.
 *
 * Uses the same in-process harness pattern as tests/cli/admin-keys.test.ts:
 * intercept process.stdout/stderr/exit, drive registerReplayCommand() through
 * a local commander Command instance.
 *
 * The CLI's loadReplayViewerModule() and loadRecordingStoreModule() call
 * require('../recording/replay-viewer.js') and require('../recording/recording-store.js').
 * Jest's moduleNameMapper strips the .js, so they resolve to the source modules
 * which we can mock via jest.mock().
 *
 * Exit codes:
 *   0 — success (null exitCode = clean return)
 *   2 — unknown recording id / usage error
 *   3 — I/O error
 *
 * Part of #852: replay HTML report enrichment.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Command } from 'commander';

// ── Module mocks ─────────────────────────────────────────────────────────────
// These mock the modules that cli/replay.ts loads at runtime via require().
// Jest's moduleNameMapper strips the .js extension so '../recording/replay-viewer.js'
// resolves to '../../src/recording/replay-viewer' from the test root.

const mockGenerateReport = jest.fn<Promise<string>, [string]>();
const mockGenerateTerminalReplay = jest.fn<Promise<string>, [string]>();
const mockInit = jest.fn<Promise<void>, []>();
const mockListRecordings = jest.fn<Promise<string[]>, []>();
const mockReadMetadata = jest.fn();
const mockReadActions = jest.fn();

jest.mock('../../src/recording/replay-viewer', () => ({
  getReplayViewer: () => ({
    generateReport: mockGenerateReport,
    generateTerminalReplay: mockGenerateTerminalReplay,
  }),
  // ReplayViewer class also exported — passthrough
  ReplayViewer: jest.fn(),
}));

jest.mock('../../src/recording/recording-store', () => ({
  getRecordingStore: () => ({
    init: mockInit,
    listRecordings: mockListRecordings,
    readMetadata: mockReadMetadata,
    readActions: mockReadActions,
  }),
  RecordingStore: jest.fn(),
}));

// Import AFTER mocks are set up
import { registerReplayCommand } from '../../cli/replay';

// ── In-process harness ───────────────────────────────────────────────────────

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

class ExitCalled extends Error {
  constructor(public readonly code: number) {
    super(`process.exit(${code})`);
  }
}

async function runCli(argv: string[]): Promise<RunResult> {
  const program = new Command();
  program.exitOverride((err) => { throw err; });
  registerReplayCommand(program);

  let stdout = '';
  let stderr = '';
  let exitCode: number | null = null;

  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  const origLogErr = console.error;
  const origExit = process.exit;

  (process.stdout.write as unknown as (chunk: string | Uint8Array) => boolean) =
    (chunk: string | Uint8Array) => {
      stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      return true;
    };
  (process.stderr.write as unknown as (chunk: string | Uint8Array) => boolean) =
    (chunk: string | Uint8Array) => {
      stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      return true;
    };
  console.error = (...args: unknown[]) => {
    stderr += args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n';
  };
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new ExitCalled(exitCode);
  }) as typeof process.exit;

  try {
    await program.parseAsync(['node', 'openchrome', ...argv]);
  } catch (err) {
    if (err instanceof ExitCalled) {
      // expected
    } else if (err && typeof err === 'object' && 'exitCode' in (err as Record<string, unknown>)) {
      exitCode = (err as { exitCode?: number }).exitCode ?? 1;
    } else {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
      console.error = origLogErr;
      process.exit = origExit;
      throw err;
    }
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    console.error = origLogErr;
    process.exit = origExit;
  }

  return { stdout, stderr, exitCode };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockInit.mockResolvedValue(undefined);
  mockListRecordings.mockResolvedValue([]);
  mockReadMetadata.mockResolvedValue(null);
  mockReadActions.mockReturnValue([]);
  mockGenerateReport.mockResolvedValue('/tmp/report.html');
  mockGenerateTerminalReplay.mockResolvedValue('=== Recording Replay ===\n');
});

// ── replay list ───────────────────────────────────────────────────────────────

describe('replay list', () => {
  it('prints header table to stderr when recordings exist', async () => {
    mockListRecordings.mockResolvedValue(['rec-20240101-120000-aaa']);
    mockReadMetadata.mockResolvedValue({
      id: 'rec-20240101-120000-aaa',
      sessionId: 'sess-1',
      startedAt: '2024-01-01T12:00:00.000Z',
      stoppedAt: '2024-01-01T12:05:00.000Z',
      actionCount: 3,
      label: 'smoke',
    });
    mockReadActions.mockReturnValue([{ ok: true }, { ok: true }, { ok: false }]);

    const { stderr, exitCode } = await runCli(['replay', 'list']);

    expect(exitCode).toBeNull();
    expect(stderr).toContain('rec-20240101-120000-aaa');
    expect(stderr).toContain('Recording ID');
    expect(stderr).toContain('Actions');
    expect(stderr).toContain('Success Rate');
    expect(stderr).toContain('Last Activity');
    expect(stderr).toContain('smoke');
  });

  it('shows "No recordings found" when store is empty', async () => {
    mockListRecordings.mockResolvedValue([]);

    const { stderr, exitCode } = await runCli(['replay', 'list']);

    expect(exitCode).toBeNull();
    expect(stderr).toContain('No recordings found');
  });

  it('exits 3 when store.init throws', async () => {
    mockInit.mockRejectedValue(new Error('disk error'));

    const { exitCode, stderr } = await runCli(['replay', 'list']);

    expect(exitCode).toBe(3);
    expect(stderr).toContain('disk error');
  });

  it('calculates success rate correctly (3/4 = 75%)', async () => {
    mockListRecordings.mockResolvedValue(['rec-test-rate']);
    mockReadMetadata.mockResolvedValue({
      id: 'rec-test-rate',
      sessionId: 'sess-x',
      startedAt: '2024-01-01T12:00:00.000Z',
      actionCount: 4,
    });
    mockReadActions.mockReturnValue([{ ok: true }, { ok: true }, { ok: true }, { ok: false }]);

    const { stderr } = await runCli(['replay', 'list']);
    expect(stderr).toContain('75%');
  });

  it('shows N/A success rate when no actions', async () => {
    mockListRecordings.mockResolvedValue(['rec-empty']);
    mockReadMetadata.mockResolvedValue({
      id: 'rec-empty',
      sessionId: 'sess-y',
      startedAt: '2024-01-01T12:00:00.000Z',
      actionCount: 0,
    });
    mockReadActions.mockReturnValue([]);

    const { stderr } = await runCli(['replay', 'list']);
    expect(stderr).toContain('N/A');
  });
});

// ── replay report ─────────────────────────────────────────────────────────────

describe('replay report', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-replay-report-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('prints the generated report path to stdout on success', async () => {
    const expectedPath = '/tmp/report.html';
    mockGenerateReport.mockResolvedValue(expectedPath);

    const { stdout, exitCode } = await runCli(['replay', 'report', 'rec-20240101-120000-aaa']);

    expect(exitCode).toBeNull();
    expect(stdout.trim()).toBe(expectedPath);
  });

  it('exits 2 when recording not found', async () => {
    mockGenerateReport.mockRejectedValue(new Error('Recording not found: rec-does-not-exist'));

    const { exitCode, stderr } = await runCli(['replay', 'report', 'rec-does-not-exist']);

    expect(exitCode).toBe(2);
    expect(stderr).toContain('rec-does-not-exist');
  });

  it('exits 2 with "Invalid recording id" message', async () => {
    mockGenerateReport.mockRejectedValue(new Error('Invalid recording id'));

    const { exitCode } = await runCli(['replay', 'report', 'bad-id']);

    expect(exitCode).toBe(2);
  });

  it('exits 3 on generic I/O error from generateReport', async () => {
    mockGenerateReport.mockRejectedValue(new Error('ENOSPC: no space left on device'));

    const { exitCode, stderr } = await runCli(['replay', 'report', 'rec-20240101-120000-aaa']);

    expect(exitCode).toBe(3);
    expect(stderr).toContain('ENOSPC');
  });

  it('copies rendered HTML to --out path and prints dest to stdout', async () => {
    // Create a real source file for the copy
    const srcPath = path.join(tmpDir, 'source-report.html');
    fs.writeFileSync(srcPath, '<!DOCTYPE html><html></html>');
    const destPath = path.join(tmpDir, 'out-report.html');
    mockGenerateReport.mockResolvedValue(srcPath);

    const { stdout, exitCode } = await runCli([
      'replay', 'report', 'rec-20240101-120000-aaa', '--out', destPath,
    ]);

    expect(exitCode).toBeNull();
    // Windows CI can surface unrelated late console output from other tests while
    // this in-process harness has stdout patched; the CLI contract only requires
    // that the destination path is emitted.
    expect(stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean)).toContain(destPath);
    expect(fs.existsSync(destPath)).toBe(true);
    expect(fs.readFileSync(destPath, 'utf-8')).toContain('<!DOCTYPE html>');
  });

  it('exits 3 when --out destination directory does not exist', async () => {
    const srcPath = path.join(tmpDir, 'source.html');
    fs.writeFileSync(srcPath, '<html/>');
    mockGenerateReport.mockResolvedValue(srcPath);

    const destPath = path.join(tmpDir, 'nonexistent-dir', 'out.html');
    const { exitCode, stderr } = await runCli([
      'replay', 'report', 'rec-20240101-120000-aaa', '--out', destPath,
    ]);

    expect(exitCode).toBe(3);
    expect(stderr).toContain('nonexistent-dir');
  });
});

// ── replay terminal ───────────────────────────────────────────────────────────

describe('replay terminal', () => {
  it('prints terminal replay output to stdout', async () => {
    const fakeOutput = '=== Recording Replay ===\n#1 navigate OK 150ms\n';
    mockGenerateTerminalReplay.mockResolvedValue(fakeOutput);

    const { stdout, exitCode } = await runCli(['replay', 'terminal', 'rec-20240101-120000-aaa']);

    expect(exitCode).toBeNull();
    expect(stdout).toContain('Recording Replay');
    expect(stdout).toContain('navigate');
  });

  it('exits 2 when recording not found', async () => {
    mockGenerateTerminalReplay.mockRejectedValue(
      new Error('Recording not found: rec-missing'),
    );

    const { exitCode, stderr } = await runCli(['replay', 'terminal', 'rec-missing']);

    expect(exitCode).toBe(2);
    expect(stderr).toContain('rec-missing');
  });

  it('exits 3 on generic error from generateTerminalReplay', async () => {
    mockGenerateTerminalReplay.mockRejectedValue(new Error('disk read error'));

    const { exitCode, stderr } = await runCli(['replay', 'terminal', 'rec-20240101-120000-aaa']);

    expect(exitCode).toBe(3);
    expect(stderr).toContain('disk read error');
  });
});
