/**
 * Tabs View - Tab list display
 */

import { ANSI, truncate, pad, horizontalLine, BOX } from '../ansi.js';
import type { TabInfo, ScreenSize } from '../types.js';
import { Renderer } from '../renderer.js';

export interface TabsViewData {
  tabs: TabInfo[];
  selectedIndex: number;
  version: string;
}

export class TabsView {
  private renderer: Renderer;

  constructor(renderer: Renderer) {
    this.renderer = renderer;
  }

  render(data: TabsViewData, size: ScreenSize): string[] {
    const lines: string[] = [];
    const width = size.columns;

    // Header
    lines.push(this.renderHeader(width));

    // Column headers
    lines.push(this.renderColumnHeaders(width));

    // Separator
    lines.push(BOX.teeRight + horizontalLine(width - 2) + BOX.teeLeft);

    // Tab list
    const listLines = this.renderTabList(data.tabs, data.selectedIndex, width, size.rows - 7);
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
    const title = 'TABS';
    const leftPart = `${ANSI.bold}${ANSI.cyan} ${title}${ANSI.reset}`;
    const leftLen = title.length + 1;
    const padding = width - leftLen - 2;
    return BOX.topLeft + leftPart + ' '.repeat(padding) + BOX.topRight;
  }

  private renderColumnHeaders(width: number): string {
    const headers = [
      pad('TAB ID', 12),
      pad('SESSION', 10),
      pad('WORKER', 10),
      pad('URL', 40),
    ];

    const content = ` ${ANSI.dim}${headers.join('  ')}${ANSI.reset}`;
    return this.renderer.contentLine(content, width);
  }

  private renderTabList(
    tabs: TabInfo[],
    selectedIndex: number,
    width: number,
    maxLines: number
  ): string[] {
    const lines: string[] = [];

    if (tabs.length === 0) {
      lines.push(this.renderer.contentLine(`${ANSI.dim}  No open tabs${ANSI.reset}`, width));
      return lines;
    }

    for (let i = 0; i < Math.min(tabs.length, maxLines); i++) {
      const tab = tabs[i];
      const isSelected = i === selectedIndex;
      lines.push(this.renderTabLine(tab, isSelected, width));
    }

    return lines;
  }

  private renderTabLine(tab: TabInfo, isSelected: boolean, width: number): string {
    const id = pad(truncate(tab.targetId, 12), 12);
    const session = pad(truncate(tab.sessionId, 10), 10);
    const worker = pad(truncate(tab.workerId || 'default', 10), 10);

    // Calculate remaining width for URL
    const fixedWidth = 12 + 10 + 10 + 6 + 4; // id + session + worker + spacing + borders
    const urlWidth = Math.max(10, width - fixedWidth);
    const url = pad(truncate(tab.url || 'about:blank', urlWidth), urlWidth);

    let content = ` ${id}  ${session}  ${worker}  ${url}`;

    if (isSelected) {
      content = `${ANSI.inverse}${content}${ANSI.reset}`;
    }

    return this.renderer.contentLine(content, width);
  }

  private renderKeyHints(width: number): string {
    const hints = [
      `${ANSI.bold}[\u2191\u2193]${ANSI.reset}Navigate`,
      `${ANSI.bold}[Enter]${ANSI.reset}Focus`,
      `${ANSI.bold}[X]${ANSI.reset}Close`,
      `${ANSI.bold}[ESC]${ANSI.reset}Back`,
    ];

    const content = ' ' + hints.join('  ');
    return this.renderer.contentLine(content, width);
  }
}
