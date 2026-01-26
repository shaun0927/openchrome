/**
 * Main View - Activity log and stats display
 */

import { ANSI, formatTime, formatDuration, formatUptime, formatBytes, truncate, pad, BOX, horizontalLine } from '../ansi.js';
import type { ToolCallEvent, DashboardStats, ScreenSize } from '../types.js';
import { Renderer } from '../renderer.js';

export interface MainViewData {
  stats: DashboardStats;
  calls: ToolCallEvent[];
  version: string;
  spinnerFrame: number;
}

export class MainView {
  private renderer: Renderer;

  constructor(renderer: Renderer) {
    this.renderer = renderer;
  }

  render(data: MainViewData, size: ScreenSize): string[] {
    const lines: string[] = [];
    const width = size.columns;

    // Header
    lines.push(this.renderHeader(data, width));

    // Stats bar
    lines.push(this.renderStatsBar(data.stats, width));

    // Separator
    lines.push(this.renderSeparator('ACTIVITY', width));

    // Activity log
    const activityLines = this.renderActivityLog(data.calls, data.spinnerFrame, width, size.rows - 7);
    lines.push(...activityLines);

    // Fill remaining space
    while (lines.length < size.rows - 2) {
      lines.push(this.renderer.emptyLine(width));
    }

    // Key hints footer
    lines.push(this.renderSeparator('', width));
    lines.push(this.renderKeyHints(data.stats.status, width));

    // Bottom border
    lines.push(this.renderer.footer(width));

    return lines;
  }

  private renderHeader(data: MainViewData, width: number): string {
    const title = `CHROME PARALLEL v${data.version}`;
    const status = data.stats.status === 'paused'
      ? `${ANSI.yellow}[PAUSED]${ANSI.reset}`
      : data.stats.status === 'running'
        ? `${ANSI.green}[RUNNING]${ANSI.reset}`
        : `${ANSI.red}[STOPPED]${ANSI.reset}`;
    const uptime = formatUptime(data.stats.uptime);

    const leftPart = `${ANSI.bold}${ANSI.cyan} ${title}${ANSI.reset}`;
    const rightPart = ` ${status} ${uptime} `;

    const leftLen = title.length + 1;
    const rightLen = 11 + 8 + 1; // [STATUS] + uptime + space

    const middlePad = Math.max(0, width - leftLen - rightLen - 2);

    return BOX.topLeft + leftPart + ' '.repeat(middlePad) + rightPart + BOX.topRight;
  }

  private renderStatsBar(stats: DashboardStats, width: number): string {
    const items = [
      `Sessions: ${ANSI.bold}${stats.sessions}${ANSI.reset}`,
      `Workers: ${ANSI.bold}${stats.workers}${ANSI.reset}`,
      `Tabs: ${ANSI.bold}${stats.tabs}${ANSI.reset}`,
      `Queue: ${ANSI.bold}${stats.queueSize}${ANSI.reset}`,
      `Memory: ${ANSI.bold}${formatBytes(stats.memoryUsage)}${ANSI.reset}`,
    ];

    const content = ' ' + items.join('    ');
    return this.renderer.contentLine(content, width);
  }

  private renderSeparator(title: string, width: number): string {
    if (!title) {
      return BOX.teeRight + horizontalLine(width - 2) + BOX.teeLeft;
    }

    const titlePart = ` ${title} `;
    const remaining = width - titlePart.length - 2;
    return BOX.teeRight + titlePart + horizontalLine(remaining) + BOX.teeLeft;
  }

  private renderActivityLog(calls: ToolCallEvent[], spinnerFrame: number, width: number, maxLines: number): string[] {
    const lines: string[] = [];

    if (calls.length === 0) {
      lines.push(this.renderer.contentLine(`${ANSI.dim}  No activity yet...${ANSI.reset}`, width));
      return lines;
    }

    const spinner = this.renderer.spinner(spinnerFrame);

    for (let i = 0; i < Math.min(calls.length, maxLines); i++) {
      const call = calls[i];
      lines.push(this.renderCallLine(call, spinner, i === 0 && call.result === 'pending', width));
    }

    return lines;
  }

  private renderCallLine(call: ToolCallEvent, spinner: string, showSpinner: boolean, width: number): string {
    const time = formatTime(call.startTime);
    const tool = pad(truncate(call.toolName, 12), 12);
    const session = call.sessionId.slice(0, 8);

    // Build description from args
    let desc = '';
    if (call.args) {
      if (call.args.url) {
        desc = truncate(String(call.args.url), 30);
      } else if (call.args.selector) {
        desc = truncate(String(call.args.selector), 30);
      } else if (call.args.javascript) {
        desc = truncate(String(call.args.javascript), 30);
      } else if (call.args.text) {
        desc = truncate(String(call.args.text), 30);
      } else {
        const keys = Object.keys(call.args);
        if (keys.length > 0) {
          desc = truncate(keys.join(', '), 30);
        }
      }
    }
    desc = pad(desc || '...', 30);

    // Duration and status
    let duration = '';
    let status = '';

    if (call.result === 'pending') {
      const elapsed = Date.now() - call.startTime;
      duration = pad(formatDuration(elapsed), 6);
      status = showSpinner ? `${ANSI.cyan}${spinner}${ANSI.reset}` : `${ANSI.cyan}...${ANSI.reset}`;
    } else {
      duration = pad(formatDuration(call.duration || 0), 6);
      status = call.result === 'success'
        ? `${ANSI.green}\u2713${ANSI.reset}`
        : `${ANSI.red}\u2717${ANSI.reset}`;
    }

    const prefix = call.result === 'pending' ? `${ANSI.cyan}\u25B6${ANSI.reset}` : ' ';

    const content = ` ${prefix} [${time}] ${tool} \u2192 ${desc} ${ANSI.dim}${session}${ANSI.reset} ${duration} ${status}`;

    return this.renderer.contentLine(content, width);
  }

  private renderKeyHints(status: string, width: number): string {
    const hints = [
      status === 'paused'
        ? `${ANSI.bold}[P]${ANSI.reset}Resume`
        : `${ANSI.bold}[P]${ANSI.reset}ause`,
      `${ANSI.bold}[S]${ANSI.reset}essions`,
      `${ANSI.bold}[T]${ANSI.reset}abs`,
      `${ANSI.bold}[C]${ANSI.reset}ancel`,
      `${ANSI.bold}[Q]${ANSI.reset}uit`,
    ];

    const content = ' ' + hints.join('  ');
    return this.renderer.contentLine(content, width);
  }
}
