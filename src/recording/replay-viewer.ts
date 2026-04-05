/**
 * Replay viewer for the Session Recording & Replay subsystem.
 * Generates HTML reports and terminal ASCII timelines from recordings.
 * Part of #572: Session Recording & Replay.
 */

import * as fs from 'fs';
import * as path from 'path';
import { RecordingStore, RECORDINGS_DIR } from './recording-store';
import { RecordingAction, RecordingMetadata } from './types';
import { generateHtmlReport } from './html-template';

/** Filename for the generated HTML report within a recording directory */
const REPORT_FILENAME = 'report.html';

/** MIME types for screenshot formats */
const SCREENSHOT_MIME: Record<string, string> = {
  webp: 'image/webp',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
};

function getScreenshotMime(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return SCREENSHOT_MIME[ext] ?? 'image/webp';
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${String(ms).padStart(4)}ms`;
  return `${(ms / 1000).toFixed(2).padStart(6)}s `;
}

/**
 * Manages HTML report generation and terminal replay for recordings.
 */
export class ReplayViewer {
  private readonly store: RecordingStore;
  private readonly baseDir: string;

  constructor(store?: RecordingStore, baseDir?: string) {
    this.baseDir = baseDir ?? RECORDINGS_DIR;
    this.store = store ?? new RecordingStore(this.baseDir);
  }

  /**
   * Generate a self-contained HTML report for a recording and save it to disk.
   * Returns the absolute path to the written report file.
   */
  async generateReport(recordingId: string): Promise<string> {
    const metadata = await this.store.readMetadata(recordingId);
    if (!metadata) {
      throw new Error(`Recording not found: ${recordingId}`);
    }

    const actions = this.store.readActions(recordingId);
    const screenshots = await this.loadScreenshots(recordingId, actions);

    const html = generateHtmlReport(metadata, actions, screenshots);

    const reportPath = path.join(this.baseDir, recordingId, REPORT_FILENAME);
    await fs.promises.writeFile(reportPath, html, 'utf-8');

    return reportPath;
  }

  /**
   * Generate a terminal ASCII timeline for a recording.
   * Returns the formatted string (suitable for printing to stderr).
   */
  async generateTerminalReplay(recordingId: string): Promise<string> {
    const metadata = await this.store.readMetadata(recordingId);
    if (!metadata) {
      throw new Error(`Recording not found: ${recordingId}`);
    }

    const actions = this.store.readActions(recordingId);
    return this.formatTerminalReplay(metadata, actions);
  }

  /**
   * Format a terminal ASCII timeline from metadata and actions (pure, no I/O).
   * Exposed for testing.
   */
  formatTerminalReplay(metadata: RecordingMetadata, actions: RecordingAction[]): string {
    const lines: string[] = [];

    // Header
    lines.push('');
    lines.push('  Recording Replay');
    lines.push(`  ID      : ${metadata.id}`);
    lines.push(`  Session : ${metadata.sessionId}`);
    if (metadata.label) {
      lines.push(`  Label   : ${metadata.label}`);
    }
    lines.push(`  Started : ${metadata.startedAt}`);
    if (metadata.stoppedAt) {
      lines.push(`  Stopped : ${metadata.stoppedAt}`);
    }
    lines.push(`  Actions : ${metadata.actionCount}`);
    lines.push('');
    lines.push('  ' + '─'.repeat(70));
    lines.push('');

    if (actions.length === 0) {
      lines.push('  (no actions recorded)');
      lines.push('');
      return lines.join('\n');
    }

    // Action rows
    for (const action of actions) {
      const ts = formatTimestamp(action.ts);
      const dur = formatDuration(action.durationMs);
      const status = action.ok ? 'OK  ' : 'FAIL';
      const isMilestone = action.seq % 10 === 0 || !action.ok;

      let line = `  [${ts}] [${dur}] ${status} #${String(action.seq).padStart(4)} ${action.tool.padEnd(22)} ${action.summary}`;

      if (isMilestone) {
        line = `> ${line.slice(2)}`; // replace leading spaces with marker
      }

      lines.push(line);

      if (action.error) {
        lines.push(`            Error: ${action.error}`);
      }
    }

    // Summary
    const successCount = actions.filter(a => a.ok).length;
    const failureCount = actions.length - successCount;
    const totalDurationMs = actions.reduce((sum, a) => sum + a.durationMs, 0);
    const successRate = actions.length > 0
      ? Math.round((successCount / actions.length) * 100)
      : 0;

    lines.push('');
    lines.push('  ' + '─'.repeat(70));
    lines.push('');
    lines.push('  Summary');
    lines.push(`    Total actions  : ${actions.length}`);
    lines.push(`    Succeeded      : ${successCount}`);
    lines.push(`    Failed         : ${failureCount}`);
    lines.push(`    Success rate   : ${successRate}%`);
    lines.push(`    Total tool time: ${formatDuration(totalDurationMs).trim()}`);
    lines.push('');

    return lines.join('\n');
  }

  /**
   * Load screenshot files for a recording and encode them as base64 data URIs.
   * Filenames referenced in actions that cannot be read are silently skipped.
   */
  /**
   * Load screenshot files for a recording and encode them as base64 data URIs.
   * Stops embedding if total encoded size exceeds MAX_EMBEDDED_BYTES (20 MB).
   * Filenames referenced in actions that cannot be read are silently skipped.
   */
  private async loadScreenshots(
    recordingId: string,
    actions: RecordingAction[],
  ): Promise<Map<string, string>> {
    const MAX_EMBEDDED_BYTES = 20 * 1024 * 1024; // 20 MB

    const filenames = new Set<string>();
    for (const action of actions) {
      if (action.screenshotBefore) filenames.add(action.screenshotBefore);
      if (action.screenshotAfter) filenames.add(action.screenshotAfter);
    }

    const map = new Map<string, string>();
    let totalBytes = 0;
    for (const filename of filenames) {
      try {
        const buf = await this.store.readScreenshot(recordingId, filename);
        if (buf) {
          const mime = getScreenshotMime(filename);
          const b64 = buf.toString('base64');
          totalBytes += b64.length;
          if (totalBytes > MAX_EMBEDDED_BYTES) {
            console.error(`[ReplayViewer] Screenshot embedding limit reached (${(MAX_EMBEDDED_BYTES / 1024 / 1024).toFixed(0)} MB). Remaining screenshots skipped.`);
            break;
          }
          map.set(filename, `data:${mime};base64,${b64}`);
        }
      } catch {
        // best-effort — skip unreadable screenshots
      }
    }

    return map;
  }
}

/** Singleton instance */
let instance: ReplayViewer | null = null;

/**
 * Get the singleton ReplayViewer instance.
 */
export function getReplayViewer(): ReplayViewer {
  if (!instance) {
    instance = new ReplayViewer();
  }
  return instance;
}
