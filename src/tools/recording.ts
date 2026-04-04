/**
 * MCP tools for Session Recording & Replay.
 * Part of #572: Session Recording & Replay.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getActionRecorder } from '../recording/action-recorder';
import { getRecordingStore } from '../recording/recording-store';
import { RecordingAction, RecordingMetadata } from '../recording/types';

// ─── oc_recording_start ───────────────────────────────────────────────────────

const startDefinition: MCPToolDefinition = {
  name: 'oc_recording_start',
  description:
    'Start a new session recording. All subsequent MCP tool calls will be recorded ' +
    'until oc_recording_stop is called. Errors if a recording is already active.',
  inputSchema: {
    type: 'object',
    properties: {
      label: {
        type: 'string',
        description: 'Optional human-readable label for this recording.',
      },
      profile: {
        type: 'string',
        description: 'Optional browser profile name to associate with this recording.',
      },
    },
  },
};

const startHandler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>,
): Promise<MCPResult> => {
  const recorder = getActionRecorder();

  if (recorder.isRecording) {
    return {
      content: [{ type: 'text', text: `Error: A recording is already active (ID: ${recorder.activeRecordingId}). Call oc_recording_stop first.` }],
      isError: true,
    };
  }

  try {
    const metadata = await recorder.start(sessionId, {
      label: args.label as string | undefined,
      profile: args.profile as string | undefined,
    });

    const lines = [
      'Recording started.',
      `  ID:      ${metadata.id}`,
      `  Session: ${metadata.sessionId}`,
      `  Started: ${metadata.startedAt}`,
    ];
    if (metadata.label) lines.push(`  Label:   ${metadata.label}`);
    if (metadata.profile) lines.push(`  Profile: ${metadata.profile}`);

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text', text: `Error starting recording: ${msg}` }],
      isError: true,
    };
  }
};

// ─── oc_recording_stop ────────────────────────────────────────────────────────

const stopDefinition: MCPToolDefinition = {
  name: 'oc_recording_stop',
  description:
    'Stop the active session recording and finalize it to disk. ' +
    'Returns a summary of the recording. Errors if no recording is active.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
};

const stopHandler: ToolHandler = async (
  _sessionId: string,
  _args: Record<string, unknown>,
): Promise<MCPResult> => {
  const recorder = getActionRecorder();

  if (!recorder.isRecording) {
    return {
      content: [{ type: 'text', text: 'Error: No active recording. Call oc_recording_start first.' }],
      isError: true,
    };
  }

  try {
    const metadata = await recorder.stop();

    const durationMs = metadata.stoppedAt && metadata.startedAt
      ? new Date(metadata.stoppedAt).getTime() - new Date(metadata.startedAt).getTime()
      : 0;
    const durationSec = (durationMs / 1000).toFixed(1);

    const lines = [
      'Recording stopped.',
      `  ID:       ${metadata.id}`,
      `  Actions:  ${metadata.actionCount}`,
      `  Duration: ${durationSec}s`,
      `  Started:  ${metadata.startedAt}`,
      `  Stopped:  ${metadata.stoppedAt ?? 'unknown'}`,
    ];
    if (metadata.label) lines.push(`  Label:    ${metadata.label}`);

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text', text: `Error stopping recording: ${msg}` }],
      isError: true,
    };
  }
};

// ─── oc_recording_list ────────────────────────────────────────────────────────

const listDefinition: MCPToolDefinition = {
  name: 'oc_recording_list',
  description: 'List available session recordings, newest first.',
  inputSchema: {
    type: 'object',
    properties: {
      limit: {
        type: 'number',
        description: 'Maximum number of recordings to return. Default: 20.',
      },
    },
  },
};

const listHandler: ToolHandler = async (
  _sessionId: string,
  args: Record<string, unknown>,
): Promise<MCPResult> => {
  const store = getRecordingStore();
  const limit = Math.max(1, Math.min((args.limit as number) || 20, 200));

  try {
    const ids = await store.listRecordings();
    const sliced = ids.slice(0, limit);

    if (sliced.length === 0) {
      return { content: [{ type: 'text', text: 'No recordings found.' }] };
    }

    const lines: string[] = [`Found ${ids.length} recording(s) (showing ${sliced.length}):`];

    for (const id of sliced) {
      const metadata = await store.readMetadata(id);
      const size = await store.getRecordingSize(id);

      if (!metadata) {
        lines.push(`  ${id}  (metadata unavailable)`);
        continue;
      }

      const startedAt = new Date(metadata.startedAt).toLocaleString();
      const sizeKb = (size / 1024).toFixed(1);

      let durationStr = '';
      if (metadata.stoppedAt) {
        const ms = new Date(metadata.stoppedAt).getTime() - new Date(metadata.startedAt).getTime();
        durationStr = ` | ${(ms / 1000).toFixed(1)}s`;
      }

      const label = metadata.label ? ` "${metadata.label}"` : '';
      lines.push(`  ${id}${label}`);
      lines.push(`    ${startedAt} | ${metadata.actionCount} actions${durationStr} | ${sizeKb} KB`);
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text', text: `Error listing recordings: ${msg}` }],
      isError: true,
    };
  }
};

// ─── oc_recording_export ──────────────────────────────────────────────────────

const exportDefinition: MCPToolDefinition = {
  name: 'oc_recording_export',
  description:
    'Export a recording as JSON or a self-contained HTML report. ' +
    'For HTML, saves to ~/.openchrome/recordings/{id}/report.html and returns the path.',
  inputSchema: {
    type: 'object',
    properties: {
      recordingId: {
        type: 'string',
        description: 'The recording ID to export.',
      },
      format: {
        type: 'string',
        enum: ['json', 'html'],
        description: 'Export format. Default: "json".',
      },
    },
    required: ['recordingId'],
  },
};

const exportHandler: ToolHandler = async (
  _sessionId: string,
  args: Record<string, unknown>,
): Promise<MCPResult> => {
  const recordingId = args.recordingId as string;
  const format = (args.format as string) || 'json';
  const store = getRecordingStore();

  const metadata = await store.readMetadata(recordingId);
  if (!metadata) {
    return {
      content: [{ type: 'text', text: `Error: Recording "${recordingId}" not found.` }],
      isError: true,
    };
  }

  const actions = store.readActions(recordingId);

  if (format === 'json') {
    const payload = { metadata, actions };
    return {
      content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    };
  }

  if (format === 'html') {
    try {
      const html = await generateHtmlReport(metadata, actions, store);
      const dir = store.getRecordingDir(recordingId);
      const filepath = path.join(dir, 'report.html');
      await fs.promises.writeFile(filepath, html, 'utf-8');
      return {
        content: [{ type: 'text', text: `HTML report saved to: ${filepath}` }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text', text: `Error generating HTML report: ${msg}` }],
        isError: true,
      };
    }
  }

  return {
    content: [{ type: 'text', text: `Error: Unknown format "${format}". Use "json" or "html".` }],
    isError: true,
  };
};

// ─── HTML report generator ────────────────────────────────────────────────────

async function generateHtmlReport(
  metadata: RecordingMetadata,
  actions: RecordingAction[],
  store: ReturnType<typeof getRecordingStore>,
): Promise<string> {
  const durationMs = metadata.stoppedAt
    ? new Date(metadata.stoppedAt).getTime() - new Date(metadata.startedAt).getTime()
    : null;
  const durationStr = durationMs !== null ? `${(durationMs / 1000).toFixed(1)}s` : 'in progress';

  // Build action rows with optional embedded screenshots
  const actionRows: string[] = [];
  for (const action of actions) {
    const time = new Date(action.ts).toLocaleTimeString();
    const statusClass = action.ok ? 'ok' : 'fail';
    const statusSymbol = action.ok ? '&#10003;' : '&#10007;';
    const argsJson = JSON.stringify(action.args, null, 2);

    let screenshotHtml = '';
    if (action.screenshotBefore || action.screenshotAfter) {
      screenshotHtml = '<div class="screenshots">';
      if (action.screenshotBefore) {
        const buf = await store.readScreenshot(metadata.id, action.screenshotBefore).catch(() => null);
        if (buf) {
          const b64 = buf.toString('base64');
          const ext = action.screenshotBefore.split('.').pop() ?? 'webp';
          const mime = ext === 'png' ? 'image/png' : ext === 'jpeg' ? 'image/jpeg' : 'image/webp';
          screenshotHtml += `<div class="screenshot"><div class="screenshot-label">Before</div><img src="data:${mime};base64,${b64}" /></div>`;
        }
      }
      if (action.screenshotAfter) {
        const buf = await store.readScreenshot(metadata.id, action.screenshotAfter).catch(() => null);
        if (buf) {
          const b64 = buf.toString('base64');
          const ext = action.screenshotAfter.split('.').pop() ?? 'webp';
          const mime = ext === 'png' ? 'image/png' : ext === 'jpeg' ? 'image/jpeg' : 'image/webp';
          screenshotHtml += `<div class="screenshot"><div class="screenshot-label">After</div><img src="data:${mime};base64,${b64}" /></div>`;
        }
      }
      screenshotHtml += '</div>';
    }

    const urlHtml = action.url ? `<div class="url">${escapeHtml(action.url)}</div>` : '';
    const errorHtml = action.error ? `<div class="error">${escapeHtml(action.error)}</div>` : '';

    actionRows.push(`
      <div class="action ${statusClass}">
        <div class="action-header">
          <span class="seq">#${action.seq}</span>
          <span class="status ${statusClass}">${statusSymbol}</span>
          <span class="tool">${escapeHtml(action.tool)}</span>
          <span class="summary">${escapeHtml(action.summary)}</span>
          <span class="duration">${action.durationMs}ms</span>
          <span class="time">${time}</span>
        </div>
        ${urlHtml}
        ${errorHtml}
        <details class="args">
          <summary>Arguments</summary>
          <pre>${escapeHtml(argsJson)}</pre>
        </details>
        ${screenshotHtml}
      </div>`);
  }

  const labelHtml = metadata.label ? `<div class="meta-item"><span class="meta-key">Label:</span> ${escapeHtml(metadata.label)}</div>` : '';
  const profileHtml = metadata.profile ? `<div class="meta-item"><span class="meta-key">Profile:</span> ${escapeHtml(metadata.profile)}</div>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Recording ${escapeHtml(metadata.id)}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f5; color: #333; }
    .header { background: #1e1e2e; color: #cdd6f4; padding: 24px 32px; }
    .header h1 { font-size: 1.4rem; font-weight: 600; margin-bottom: 8px; }
    .header .id { font-family: monospace; font-size: 0.85rem; color: #89b4fa; }
    .meta { display: flex; flex-wrap: wrap; gap: 16px; margin-top: 12px; font-size: 0.85rem; color: #a6adc8; }
    .meta-key { color: #89dceb; }
    .timeline { max-width: 960px; margin: 24px auto; padding: 0 16px; }
    .action { background: #fff; border-radius: 8px; margin-bottom: 12px; border: 1px solid #e0e0e0; overflow: hidden; }
    .action.fail { border-left: 4px solid #f38ba8; }
    .action.ok { border-left: 4px solid #a6e3a1; }
    .action-header { display: flex; align-items: center; gap: 10px; padding: 10px 14px; flex-wrap: wrap; }
    .seq { font-size: 0.75rem; color: #888; min-width: 30px; }
    .status { font-size: 1rem; }
    .status.ok { color: #40a02b; }
    .status.fail { color: #d20f39; }
    .tool { font-family: monospace; font-weight: 600; font-size: 0.9rem; color: #1e1e2e; }
    .summary { flex: 1; font-size: 0.85rem; color: #555; }
    .duration { font-size: 0.75rem; color: #888; }
    .time { font-size: 0.75rem; color: #aaa; }
    .url { padding: 4px 14px 4px 54px; font-size: 0.78rem; color: #0969da; font-family: monospace; word-break: break-all; background: #f8f9fa; }
    .error { padding: 6px 14px 6px 54px; font-size: 0.8rem; color: #d20f39; background: #fff5f5; }
    .args { padding: 4px 14px 10px 54px; }
    .args summary { font-size: 0.78rem; color: #777; cursor: pointer; }
    .args pre { margin-top: 6px; font-size: 0.78rem; background: #f5f5f5; padding: 8px; border-radius: 4px; overflow-x: auto; white-space: pre-wrap; }
    .screenshots { display: flex; gap: 12px; padding: 8px 14px 12px 54px; flex-wrap: wrap; }
    .screenshot img { max-width: 320px; border-radius: 4px; border: 1px solid #ddd; display: block; }
    .screenshot-label { font-size: 0.7rem; color: #888; margin-bottom: 4px; }
    .empty { text-align: center; color: #888; padding: 48px; }
  </style>
</head>
<body>
  <div class="header">
    <h1>Session Recording Report</h1>
    <div class="id">${escapeHtml(metadata.id)}</div>
    <div class="meta">
      <div class="meta-item"><span class="meta-key">Started:</span> ${escapeHtml(metadata.startedAt)}</div>
      <div class="meta-item"><span class="meta-key">Duration:</span> ${durationStr}</div>
      <div class="meta-item"><span class="meta-key">Actions:</span> ${metadata.actionCount}</div>
      <div class="meta-item"><span class="meta-key">Session:</span> ${escapeHtml(metadata.sessionId)}</div>
      ${labelHtml}
      ${profileHtml}
    </div>
  </div>
  <div class="timeline">
    ${actionRows.length > 0 ? actionRows.join('\n') : '<div class="empty">No actions recorded.</div>'}
  </div>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Registration ─────────────────────────────────────────────────────────────

export function registerRecordingTools(server: MCPServer): void {
  server.registerTool(startDefinition.name, startHandler, startDefinition);
  server.registerTool(stopDefinition.name, stopHandler, stopDefinition);
  server.registerTool(listDefinition.name, listHandler, listDefinition);
  server.registerTool(exportDefinition.name, exportHandler, exportDefinition);
}
