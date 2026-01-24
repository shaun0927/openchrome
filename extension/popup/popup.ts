/**
 * Popup Script - Extension popup UI
 */

interface SessionInfo {
  id: string;
  tabGroupId: number;
  tabCount: number;
  createdAt: number;
  lastActivityAt: number;
  name: string;
}

const TAB_GROUP_COLOR_MAP: Record<string, string> = {
  grey: '#888888',
  blue: '#3b82f6',
  red: '#ef4444',
  yellow: '#eab308',
  green: '#22c55e',
  pink: '#ec4899',
  purple: '#a855f7',
  cyan: '#06b6d4',
  orange: '#f97316',
};

/**
 * Format relative time
 */
function formatRelativeTime(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);

  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

/**
 * Create session item HTML
 */
function createSessionItem(session: SessionInfo, groupColor?: string): HTMLElement {
  const item = document.createElement('div');
  item.className = 'session-item';

  const colorDot = document.createElement('div');
  colorDot.className = 'session-color';
  colorDot.style.backgroundColor = TAB_GROUP_COLOR_MAP[groupColor || 'purple'] || '#a855f7';

  const info = document.createElement('div');
  info.className = 'session-info';

  const name = document.createElement('div');
  name.className = 'session-name';
  name.textContent = session.name;

  const meta = document.createElement('div');
  meta.className = 'session-meta';
  meta.textContent = `Active ${formatRelativeTime(session.lastActivityAt)}`;

  info.appendChild(name);
  info.appendChild(meta);

  const tabs = document.createElement('div');
  tabs.className = 'session-tabs';
  tabs.textContent = `${session.tabCount} tabs`;

  item.appendChild(colorDot);
  item.appendChild(info);
  item.appendChild(tabs);

  return item;
}

/**
 * Fetch sessions from service worker
 */
async function fetchSessions(): Promise<SessionInfo[]> {
  return new Promise((resolve) => {
    const port = chrome.runtime.connect({ name: 'mcp' });

    port.postMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'sessions/list',
    });

    port.onMessage.addListener((response) => {
      if (response.result?.content?.[0]?.text) {
        try {
          const sessions = JSON.parse(response.result.content[0].text);
          resolve(sessions);
        } catch {
          resolve([]);
        }
      } else {
        resolve([]);
      }
      port.disconnect();
    });

    // Timeout after 2 seconds
    setTimeout(() => {
      resolve([]);
      port.disconnect();
    }, 2000);
  });
}

/**
 * Cleanup inactive sessions
 */
async function cleanupSessions(): Promise<void> {
  const port = chrome.runtime.connect({ name: 'mcp' });

  port.postMessage({
    jsonrpc: '2.0',
    id: 1,
    method: 'sessions/cleanup',
  });

  return new Promise((resolve) => {
    port.onMessage.addListener(() => {
      port.disconnect();
      resolve();
    });

    setTimeout(() => {
      port.disconnect();
      resolve();
    }, 2000);
  });
}

/**
 * Update the UI with session data
 */
async function updateUI(): Promise<void> {
  const sessions = await fetchSessions();

  // Update session count
  const countEl = document.getElementById('session-count');
  if (countEl) {
    countEl.textContent = String(sessions.length);
  }

  // Update session list
  const listEl = document.getElementById('session-list');
  if (!listEl) return;

  if (sessions.length === 0) {
    listEl.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">📭</div>
        <div class="empty-state-text">No active sessions</div>
      </div>
    `;
    return;
  }

  listEl.innerHTML = '';

  // Sort by last activity (most recent first)
  sessions.sort((a, b) => b.lastActivityAt - a.lastActivityAt);

  for (const session of sessions) {
    // Try to get tab group color
    let groupColor: string | undefined;
    if (session.tabGroupId > 0) {
      try {
        const group = await chrome.tabGroups.get(session.tabGroupId);
        groupColor = group.color;
      } catch {
        // Group might not exist
      }
    }

    const item = createSessionItem(session, groupColor);
    listEl.appendChild(item);
  }
}

/**
 * Initialize popup
 */
function init(): void {
  // Initial update
  updateUI();

  // Refresh button
  const refreshBtn = document.getElementById('refresh-btn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      updateUI();
    });
  }

  // Cleanup button
  const cleanupBtn = document.getElementById('cleanup-btn');
  if (cleanupBtn) {
    cleanupBtn.addEventListener('click', async () => {
      await cleanupSessions();
      await updateUI();
    });
  }

  // Auto-refresh every 5 seconds
  setInterval(updateUI, 5000);
}

// Run when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
