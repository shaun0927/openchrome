/**
 * HTML report template for the Session Recording & Replay subsystem.
 * Generates a self-contained single-file HTML report from recording data.
 * Part of #572: Session Recording & Replay.
 */

import { RecordingAction, RecordingMetadata } from './types';

/** Tool categories for color-coded badges */
const TOOL_CATEGORIES: Record<string, string> = {
  navigate: 'navigation',
  page_reload: 'navigation',
  tabs_create: 'navigation',
  tabs_close: 'navigation',
  tabs_context: 'navigation',
  wait_for: 'navigation',
  interact: 'interaction',
  fill_form: 'interaction',
  form_input: 'interaction',
  computer: 'interaction',
  find: 'interaction',
  lightweight_scroll: 'interaction',
  read_page: 'data',
  query_dom: 'data',
  inspect: 'data',
  javascript_tool: 'data',
  cookies: 'data',
  storage: 'data',
  memory: 'data',
};

function getToolCategory(tool: string): string {
  return TOOL_CATEGORIES[tool] ?? 'default';
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatIso(iso: string | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
  } catch {
    return iso;
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function computeStats(actions: RecordingAction[]): {
  totalActions: number;
  successCount: number;
  failureCount: number;
  successRate: string;
  totalDurationMs: number;
  toolsUsed: string[];
} {
  const successCount = actions.filter(a => a.ok).length;
  const failureCount = actions.length - successCount;
  const totalDurationMs = actions.reduce((sum, a) => sum + a.durationMs, 0);
  const toolsUsed = [...new Set(actions.map(a => a.tool))].sort();
  const successRate = actions.length > 0
    ? `${Math.round((successCount / actions.length) * 100)}%`
    : 'N/A';
  return { totalActions: actions.length, successCount, failureCount, successRate, totalDurationMs, toolsUsed };
}

function renderActionCard(action: RecordingAction, screenshots: Map<string, string>): string {
  const category = getToolCategory(action.tool);
  const statusClass = action.ok ? 'ok' : 'fail';
  const statusIcon = action.ok ? '&#x2713;' : '&#x2717;';
  const argsJson = escapeHtml(JSON.stringify(action.args, null, 2));

  let screenshotBefore = '';
  if (action.screenshotBefore) {
    const dataUri = screenshots.get(action.screenshotBefore);
    if (dataUri) {
      screenshotBefore = `
        <div class="screenshot-pair">
          <span class="screenshot-label">Before</span>
          <img class="screenshot" src="${escapeHtml(dataUri)}" alt="Screenshot before action ${action.seq}" loading="lazy" />
        </div>`;
    }
  }

  let screenshotAfter = '';
  if (action.screenshotAfter) {
    const dataUri = screenshots.get(action.screenshotAfter);
    if (dataUri) {
      screenshotAfter = `
        <div class="screenshot-pair">
          <span class="screenshot-label">After</span>
          <img class="screenshot" src="${escapeHtml(dataUri)}" alt="Screenshot after action ${action.seq}" loading="lazy" />
        </div>`;
    }
  }

  const screenshotSection = (screenshotBefore || screenshotAfter)
    ? `<div class="screenshots">${screenshotBefore}${screenshotAfter}</div>`
    : '';

  const errorSection = action.error
    ? `<div class="error-msg">Error: ${escapeHtml(action.error)}</div>`
    : '';

  const urlSection = action.url
    ? `<div class="action-url" title="${escapeHtml(action.url)}">&#x1F517; ${escapeHtml(action.url)}</div>`
    : '';

  return `
    <div class="action-card ${statusClass}" data-seq="${action.seq}" data-tool="${escapeHtml(action.tool)}" data-ok="${action.ok}">
      <div class="action-header">
        <span class="seq-num">#${action.seq}</span>
        <span class="badge badge-${category}">${escapeHtml(action.tool)}</span>
        <span class="action-summary">${escapeHtml(action.summary)}</span>
        <div class="action-meta">
          <span class="timestamp">&#x23F0; ${formatTimestamp(action.ts)}</span>
          <span class="duration">&#x23F1; ${formatDuration(action.durationMs)}</span>
          <span class="status-icon ${statusClass}">${statusIcon}</span>
        </div>
      </div>
      ${urlSection}
      ${errorSection}
      <details class="args-details">
        <summary>Arguments</summary>
        <pre class="args-json"><code>${argsJson}</code></pre>
      </details>
      ${screenshotSection}
    </div>`;
}

/**
 * Generate a self-contained HTML report from a recording.
 *
 * @param metadata - Recording metadata
 * @param actions - Ordered list of recorded actions
 * @param screenshots - Map of filename to base64 data URI (e.g. "data:image/webp;base64,...")
 */
export function generateHtmlReport(
  metadata: RecordingMetadata,
  actions: RecordingAction[],
  screenshots: Map<string, string> = new Map(),
): string {
  const stats = computeStats(actions);
  const actionCards = actions.map(a => renderActionCard(a, screenshots)).join('\n');

  const sessionDuration = metadata.stoppedAt && metadata.startedAt
    ? formatDuration(new Date(metadata.stoppedAt).getTime() - new Date(metadata.startedAt).getTime())
    : '—';

  const toolOptions = stats.toolsUsed
    .map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`)
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Recording Report — ${escapeHtml(metadata.id)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg: #1a1a2e;
      --bg2: #16213e;
      --bg3: #0f3460;
      --surface: #1e1e3f;
      --surface2: #252550;
      --border: #2a2a5a;
      --text: #e0e0f0;
      --text-muted: #8888aa;
      --accent: #4f8ef7;
      --ok: #22c55e;
      --fail: #ef4444;
      --nav: #3b82f6;
      --interaction: #22c55e;
      --data: #a855f7;
      --default-badge: #6b7280;
      --font-mono: 'Courier New', Courier, monospace;
    }

    body {
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 14px;
      line-height: 1.5;
      min-height: 100vh;
    }

    /* ── Header ── */
    .header {
      position: sticky;
      top: 0;
      z-index: 100;
      background: var(--bg2);
      border-bottom: 1px solid var(--border);
      padding: 12px 20px;
    }

    .header-top {
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
      margin-bottom: 8px;
    }

    .header-title {
      font-size: 18px;
      font-weight: 700;
      color: var(--accent);
      flex: 1;
      min-width: 200px;
    }

    .meta-grid {
      display: flex;
      flex-wrap: wrap;
      gap: 8px 20px;
      font-size: 12px;
      color: var(--text-muted);
    }

    .meta-item strong { color: var(--text); }

    /* ── Filter bar ── */
    .filter-bar {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      padding: 8px 20px;
      background: var(--bg3);
      border-bottom: 1px solid var(--border);
    }

    .filter-bar label { font-size: 12px; color: var(--text-muted); }

    .filter-bar select,
    .filter-bar input[type="text"] {
      background: var(--surface);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 4px 8px;
      font-size: 12px;
    }

    .filter-bar input[type="checkbox"] { accent-color: var(--accent); }

    .filter-count {
      margin-left: auto;
      font-size: 12px;
      color: var(--text-muted);
    }

    /* ── Stats bar ── */
    .stats-bar {
      display: flex;
      flex-wrap: wrap;
      gap: 12px 24px;
      padding: 10px 20px;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
    }

    .stat {
      display: flex;
      flex-direction: column;
      align-items: center;
      min-width: 80px;
    }

    .stat-value {
      font-size: 20px;
      font-weight: 700;
      color: var(--accent);
    }

    .stat-value.ok { color: var(--ok); }
    .stat-value.fail { color: var(--fail); }

    .stat-label {
      font-size: 11px;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    /* ── Action list ── */
    .action-list {
      padding: 16px 20px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .action-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px 14px;
      transition: border-color 0.15s, box-shadow 0.15s;
      cursor: default;
    }

    .action-card:hover {
      border-color: var(--accent);
      box-shadow: 0 0 0 1px var(--accent);
    }

    .action-card.focused {
      border-color: var(--accent);
      box-shadow: 0 0 0 2px var(--accent);
      outline: none;
    }

    .action-card.fail { border-left: 3px solid var(--fail); }
    .action-card.ok  { border-left: 3px solid var(--ok); }

    .action-header {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }

    .seq-num {
      font-size: 11px;
      color: var(--text-muted);
      font-family: var(--font-mono);
      min-width: 32px;
    }

    /* ── Badges ── */
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 99px;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.03em;
      white-space: nowrap;
    }

    .badge-navigation  { background: rgba(59,130,246,0.2);  color: #60a5fa; }
    .badge-interaction { background: rgba(34,197,94,0.2);   color: #4ade80; }
    .badge-data        { background: rgba(168,85,247,0.2);  color: #c084fc; }
    .badge-default     { background: rgba(107,114,128,0.2); color: #9ca3af; }

    .action-summary {
      flex: 1;
      font-size: 13px;
      color: var(--text);
      min-width: 120px;
      word-break: break-word;
    }

    .action-meta {
      display: flex;
      gap: 10px;
      align-items: center;
      font-size: 11px;
      color: var(--text-muted);
      white-space: nowrap;
    }

    .status-icon.ok   { color: var(--ok);   font-size: 14px; font-weight: 700; }
    .status-icon.fail { color: var(--fail);  font-size: 14px; font-weight: 700; }

    .action-url {
      font-size: 11px;
      color: var(--text-muted);
      font-family: var(--font-mono);
      margin-top: 6px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .error-msg {
      margin-top: 6px;
      padding: 6px 10px;
      background: rgba(239,68,68,0.1);
      border: 1px solid rgba(239,68,68,0.3);
      border-radius: 4px;
      font-size: 12px;
      color: #fca5a5;
      word-break: break-word;
    }

    /* ── Args collapsible ── */
    .args-details {
      margin-top: 8px;
    }

    .args-details summary {
      font-size: 11px;
      color: var(--text-muted);
      cursor: pointer;
      user-select: none;
      padding: 2px 0;
    }

    .args-details summary:hover { color: var(--text); }

    .args-json {
      margin-top: 6px;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 10px;
      overflow-x: auto;
      font-family: var(--font-mono);
      font-size: 12px;
      line-height: 1.6;
      color: #a5b4fc;
      white-space: pre;
    }

    /* ── Screenshots ── */
    .screenshots {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      margin-top: 10px;
    }

    .screenshot-pair {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .screenshot-label {
      font-size: 10px;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .screenshot {
      max-width: min(380px, 45vw);
      max-height: 260px;
      border-radius: 4px;
      border: 1px solid var(--border);
      object-fit: contain;
    }

    /* ── Empty state ── */
    .empty-state {
      padding: 60px 20px;
      text-align: center;
      color: var(--text-muted);
      font-size: 16px;
    }

    /* ── Keyboard hint ── */
    .kbd-hint {
      padding: 6px 20px;
      font-size: 11px;
      color: var(--text-muted);
      background: var(--bg2);
      border-top: 1px solid var(--border);
      text-align: right;
    }

    kbd {
      background: var(--surface2);
      border: 1px solid var(--border);
      border-radius: 3px;
      padding: 1px 5px;
      font-size: 10px;
      font-family: var(--font-mono);
    }

    /* hidden by filter */
    .action-card.hidden { display: none; }
  </style>
</head>
<body>

  <header class="header">
    <div class="header-top">
      <div class="header-title">&#x1F3A5; Recording Report</div>
    </div>
    <div class="meta-grid">
      <div class="meta-item"><strong>ID:</strong> ${escapeHtml(metadata.id)}</div>
      <div class="meta-item"><strong>Session:</strong> ${escapeHtml(metadata.sessionId)}</div>
      ${metadata.label ? `<div class="meta-item"><strong>Label:</strong> ${escapeHtml(metadata.label)}</div>` : ''}
      ${metadata.profile ? `<div class="meta-item"><strong>Profile:</strong> ${escapeHtml(metadata.profile)}</div>` : ''}
      <div class="meta-item"><strong>Started:</strong> ${escapeHtml(formatIso(metadata.startedAt))}</div>
      <div class="meta-item"><strong>Stopped:</strong> ${escapeHtml(formatIso(metadata.stoppedAt))}</div>
      <div class="meta-item"><strong>Duration:</strong> ${escapeHtml(sessionDuration)}</div>
      <div class="meta-item"><strong>Actions:</strong> ${metadata.actionCount}</div>
    </div>
  </header>

  <div class="stats-bar">
    <div class="stat">
      <span class="stat-value">${stats.totalActions}</span>
      <span class="stat-label">Total Actions</span>
    </div>
    <div class="stat">
      <span class="stat-value ok">${stats.successCount}</span>
      <span class="stat-label">Succeeded</span>
    </div>
    <div class="stat">
      <span class="stat-value${stats.failureCount > 0 ? ' fail' : ''}">${stats.failureCount}</span>
      <span class="stat-label">Failed</span>
    </div>
    <div class="stat">
      <span class="stat-value">${escapeHtml(stats.successRate)}</span>
      <span class="stat-label">Success Rate</span>
    </div>
    <div class="stat">
      <span class="stat-value">${escapeHtml(formatDuration(stats.totalDurationMs))}</span>
      <span class="stat-label">Total Tool Time</span>
    </div>
    <div class="stat">
      <span class="stat-value">${stats.toolsUsed.length}</span>
      <span class="stat-label">Unique Tools</span>
    </div>
  </div>

  <div class="filter-bar">
    <label for="filter-tool">Tool:</label>
    <select id="filter-tool">
      <option value="">All tools</option>
      ${toolOptions}
    </select>

    <label>
      <input type="checkbox" id="filter-failures" />
      Failures only
    </label>

    <label for="filter-search">Search:</label>
    <input type="text" id="filter-search" placeholder="summary, URL, error…" style="width:200px" />

    <span class="filter-count" id="filter-count">${stats.totalActions} actions</span>
  </div>

  <main class="action-list" id="action-list">
    ${actions.length === 0
      ? '<div class="empty-state">No actions recorded.</div>'
      : actionCards
    }
  </main>

  <div class="kbd-hint">
    Keyboard: <kbd>&#x2191;</kbd> <kbd>&#x2193;</kbd> prev/next action
  </div>

  <script>
    (function () {
      'use strict';

      var cards = Array.from(document.querySelectorAll('.action-card'));
      var focusIdx = -1;

      function applyFilters() {
        var tool = document.getElementById('filter-tool').value;
        var failuresOnly = document.getElementById('filter-failures').checked;
        var search = document.getElementById('filter-search').value.toLowerCase();
        var visible = 0;

        cards.forEach(function (card) {
          var matchTool = !tool || card.dataset.tool === tool;
          var matchFail = !failuresOnly || card.dataset.ok === 'false';
          var matchSearch = !search || card.textContent.toLowerCase().includes(search);
          var show = matchTool && matchFail && matchSearch;
          card.classList.toggle('hidden', !show);
          if (show) visible++;
        });

        document.getElementById('filter-count').textContent = visible + ' action' + (visible !== 1 ? 's' : '');
      }

      document.getElementById('filter-tool').addEventListener('change', applyFilters);
      document.getElementById('filter-failures').addEventListener('change', applyFilters);
      document.getElementById('filter-search').addEventListener('input', applyFilters);

      function getVisible() {
        return cards.filter(function (c) { return !c.classList.contains('hidden'); });
      }

      function focusCard(idx) {
        var visible = getVisible();
        if (!visible.length) return;
        idx = Math.max(0, Math.min(idx, visible.length - 1));
        if (focusIdx >= 0 && focusIdx < visible.length) {
          visible[focusIdx].classList.remove('focused');
        }
        focusIdx = idx;
        visible[focusIdx].classList.add('focused');
        visible[focusIdx].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }

      document.addEventListener('keydown', function (e) {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
        if (e.key === 'ArrowDown' || e.key === 'j') {
          e.preventDefault();
          focusCard(focusIdx + 1);
        } else if (e.key === 'ArrowUp' || e.key === 'k') {
          e.preventDefault();
          focusCard(focusIdx <= 0 ? 0 : focusIdx - 1);
        }
      });
    })();
  </script>

</body>
</html>`;
}
