/**
 * `openchrome replay` — CLI subcommands for the Session Recording & Replay subsystem.
 *
 * Subcommands:
 *   replay list                        — table of all recordings
 *   replay report <id> [--out PATH]    — generate / copy HTML report
 *   replay terminal <id>               — print ASCII timeline
 *
 * Because the CLI tsconfig has rootDir=./cli, we pull recording modules from
 * the compiled dist via runtime require(), following the same pattern used in
 * contract-teach.ts.
 *
 * Exit codes:
 *   0 — success
 *   2 — unknown recording id / usage error
 *   3 — I/O error
 *
 * Part of #852: replay HTML report enrichment.
 */

import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Runtime module loader (avoids rootDir constraint)
// ---------------------------------------------------------------------------

interface RecordingMetadata {
  version: number;
  id: string;
  sessionId: string;
  startedAt: string;
  stoppedAt?: string;
  actionCount: number;
  profile?: string;
  label?: string;
}

interface ReplayViewerModule {
  getReplayViewer(): {
    generateReport(id: string): Promise<string>;
    generateTerminalReplay(id: string): Promise<string>;
  };
}

interface RecordingStoreModule {
  getRecordingStore(): {
    init(): Promise<void>;
    listRecordings(): Promise<string[]>;
    readMetadata(id: string): Promise<RecordingMetadata | null>;
    readActions(id: string): Array<{ ok: boolean }>;
  };
}

function tryRequire<T>(candidates: readonly string[], label: string): T {
  let lastErr: unknown;
  for (const spec of candidates) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return require(spec) as T;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `Unable to load ${label} from any candidate path: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
}

function loadReplayViewerModule(): ReplayViewerModule {
  // Two candidates: post-dist (cli/replay.js → ../recording/replay-viewer.js) and
  // ts-jest source tree (cli/replay.ts → ../src/recording/replay-viewer).
  return tryRequire<ReplayViewerModule>(
    ['../recording/replay-viewer.js', '../src/recording/replay-viewer'],
    'replay-viewer',
  );
}

function loadRecordingStoreModule(): RecordingStoreModule {
  return tryRequire<RecordingStoreModule>(
    ['../recording/recording-store.js', '../src/recording/recording-store'],
    'recording-store',
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(iso: string | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
  } catch {
    return iso;
  }
}

function padEnd(str: string, len: number): string {
  return str.length >= len ? str : str + ' '.repeat(len - str.length);
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerReplayCommand(program: Command): void {
  const replay = program
    .command('replay')
    .description('Manage and inspect session recordings');

  // ── replay list ───────────────────────────────────────────────────────────
  replay
    .command('list')
    .description('List all recordings sorted by last activity (newest first)')
    .action(async () => {
      try {
        const storeModule = loadRecordingStoreModule();
        const store = storeModule.getRecordingStore();
        await store.init();

        const ids = await store.listRecordings();
        if (ids.length === 0) {
          process.stderr.write('No recordings found.\n');
          return;
        }

        // Collect rows
        const rows: Array<{
          id: string;
          actions: string;
          lastActivity: string;
          successRate: string;
          label: string;
        }> = [];

        for (const id of ids) {
          const meta = await store.readMetadata(id);
          if (!meta) continue;

          const actions = store.readActions(id);
          const successCount = actions.filter((a) => a.ok).length;
          const successRate =
            actions.length > 0
              ? `${Math.round((successCount / actions.length) * 100)}%`
              : 'N/A';

          rows.push({
            id,
            actions: String(meta.actionCount),
            lastActivity: formatDate(meta.stoppedAt ?? meta.startedAt),
            successRate,
            label: meta.label ?? '',
          });
        }

        // Column widths
        const idW = Math.max(11, ...rows.map((r) => r.id.length));
        const actW = Math.max(7, ...rows.map((r) => r.actions.length));
        const rateW = Math.max(12, ...rows.map((r) => r.successRate.length));
        const tsW = Math.max(24, ...rows.map((r) => r.lastActivity.length));
        const labelW = Math.max(5, ...rows.map((r) => r.label.length));

        const header =
          padEnd('Recording ID', idW) +
          '  ' +
          padEnd('Actions', actW) +
          '  ' +
          padEnd('Success Rate', rateW) +
          '  ' +
          padEnd('Last Activity', tsW) +
          '  ' +
          padEnd('Label', labelW);
        const sep = '-'.repeat(header.length);

        process.stderr.write(header + '\n');
        process.stderr.write(sep + '\n');
        for (const row of rows) {
          const line =
            padEnd(row.id, idW) +
            '  ' +
            padEnd(row.actions, actW) +
            '  ' +
            padEnd(row.successRate, rateW) +
            '  ' +
            padEnd(row.lastActivity, tsW) +
            '  ' +
            padEnd(row.label, labelW);
          process.stderr.write(line + '\n');
        }
      } catch (err) {
        process.stderr.write(
          `Error listing recordings: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(3);
      }
    });

  // ── replay report ─────────────────────────────────────────────────────────
  replay
    .command('report <id>')
    .description('Generate HTML report for a recording')
    .option('--out <path>', 'Copy the rendered HTML to this path atomically')
    .action(async (id: string, options: { out?: string }) => {
      try {
        const viewerModule = loadReplayViewerModule();
        const viewer = viewerModule.getReplayViewer();

        let reportPath: string;
        try {
          reportPath = await viewer.generateReport(id);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('Recording not found') || msg.includes('Invalid recording id')) {
            process.stderr.write(`Recording not found: ${id}\n`);
            process.exit(2);
          }
          throw err;
        }

        if (options.out) {
          const dest = path.resolve(options.out);
          try {
            // Write atomically using a temp file + rename (async I/O)
            const tmp = dest + '.tmp';
            const content = await fs.promises.readFile(reportPath);
            await fs.promises.writeFile(tmp, content);
            await fs.promises.rename(tmp, dest);
            process.stdout.write(dest + '\n');
          } catch (ioErr) {
            process.stderr.write(
              `Failed to write report to ${dest}: ${ioErr instanceof Error ? ioErr.message : String(ioErr)}\n`,
            );
            process.exit(3);
          }
        } else {
          process.stdout.write(reportPath + '\n');
        }
      } catch (err) {
        // Preserve exit signals already raised by inner handlers (test harnesses
        // typically intercept process.exit() by throwing; we must not overwrite
        // the inner exit code with 3 here).
        if (err instanceof Error && err.message.startsWith('process.exit(')) {
          throw err;
        }
        process.stderr.write(
          `Error generating report: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(3);
      }
    });

  // ── replay terminal ───────────────────────────────────────────────────────
  replay
    .command('terminal <id>')
    .description('Print ASCII timeline for a recording')
    .action(async (id: string) => {
      try {
        const viewerModule = loadReplayViewerModule();
        const viewer = viewerModule.getReplayViewer();

        let output: string;
        try {
          output = await viewer.generateTerminalReplay(id);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('Recording not found') || msg.includes('Invalid recording id')) {
            process.stderr.write(`Recording not found: ${id}\n`);
            process.exit(2);
          }
          throw err;
        }

        process.stdout.write(output + '\n');
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('process.exit(')) {
          throw err;
        }
        process.stderr.write(
          `Error generating terminal replay: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(3);
      }
    });
}
