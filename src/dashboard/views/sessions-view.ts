/**
 * Sessions View - Session list display
 */

import { ANSI, formatTime, formatDuration, truncate, pad, horizontalLine, BOX } from '../ansi.js';
import type { SessionInfo, ScreenSize } from '../types.js';
import { Renderer } from '../renderer.js';

export interface SessionsViewData {
  sessions: SessionInfo[];
  selectedIndex: number;
  version: string;
}

export class SessionsView {
  private renderer: Renderer;

  constructor(renderer: Renderer) {
    this.renderer = renderer;
  }

  render(data: SessionsViewData, size: ScreenSize): string[] {
    const lines: string[] = [];
    const width = size.columns;

    // Header
    lines.push(this.renderHeader(width));

    // Column headers
    lines.push(this.renderColumnHeaders(width));

    // Separator
    lines.push(BOX.teeRight + horizontalLine(width - 2) + BOX.teeLeft);

    // Session list
    const listLines = this.renderSessionList(data.sessions, data.selectedIndex, width, size.rows - 7);
    lines.push(...listLines);

    // Fill remaining space
    while (lines.length < size.rows - 2) {
      lines.push(this.renderer.emptyLine(width));
    }

    // Key hints
    lines.push(BOX.teeRight + horizontalLine(width - 2) + BOX.teeLeft);
    lines.push(this.renderKeyHints(width));

    // Bottom border
    lines.push(this.renderer.footer(width));

    return lines;
  }

  private renderHeader(width: number): string {
    const title = 'SESSIONS';
    const leftPart = `${ANSI.bold}${ANSI.cyan} ${title}${ANSI.reset}`;
    const leftLen = title.length + 1;
    const padding = width - leftLen - 2;
    return BOX.topLeft + leftPart + ' '.repeat(padding) + BOX.topRight;
  }

  private renderColumnHeaders(width: number): string {
    const headers = [
      pad('SESSION ID', 12),
      pad('WORKERS', 8),
      pad('TABS', 6),
      pad('CREATED', 10),
      pad('LAST ACTIVITY', 15),
    ];

    const content = ` ${ANSI.dim}${headers.join('  ')}${ANSI.reset}`;
    return this.renderer.contentLine(content, width);
  }

  private renderSessionList(
    sessions: SessionInfo[],
    selectedIndex: number,
    width: number,
    maxLines: number
  ): string[] {
    const lines: string[] = [];

    if (sessions.length === 0) {
      lines.push(this.renderer.contentLine(`${ANSI.dim}  No active sessions${ANSI.reset}`, width));
      return lines;
    }

    for (let i = 0; i < Math.min(sessions.length, maxLines); i++) {
      const session = sessions[i];
      const isSelected = i === selectedIndex;
      lines.push(this.renderSessionLine(session, isSelected, width));
    }

    return lines;
  }

  private renderSessionLine(session: SessionInfo, isSelected: boolean, width: number): string {
    const id = pad(truncate(session.id, 12), 12);
    const workers = pad(String(session.workerCount), 8);
    const tabs = pad(String(session.tabCount), 6);
    const created = pad(formatTime(session.createdAt), 10);
    const lastActivity = pad(this.formatRelativeTime(session.lastActivity), 15);

    let content = ` ${id}  ${workers}  ${tabs}  ${created}  ${lastActivity}`;

    if (isSelected) {
      content = `${ANSI.inverse}${content}${ANSI.reset}`;
    }

    return this.renderer.contentLine(content, width);
  }

  private formatRelativeTime(timestamp: number): string {
    const elapsed = Date.now() - timestamp;

    if (elapsed < 1000) {
      return 'just now';
    }
    if (elapsed < 60000) {
      return `${Math.floor(elapsed / 1000)}s ago`;
    }
    if (elapsed < 3600000) {
      return `${Math.floor(elapsed / 60000)}m ago`;
    }
    return `${Math.floor(elapsed / 3600000)}h ago`;
  }

  private renderKeyHints(width: number): string {
    const hints = [
      `${ANSI.bold}[\u2191\u2193]${ANSI.reset}Navigate`,
      `${ANSI.bold}[Enter]${ANSI.reset}Details`,
      `${ANSI.bold}[D]${ANSI.reset}elete`,
      `${ANSI.bold}[ESC]${ANSI.reset}Back`,
    ];

    const content = ' ' + hints.join('  ');
    return this.renderer.contentLine(content, width);
  }
}
