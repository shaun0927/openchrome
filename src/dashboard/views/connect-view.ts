/**
 * Connect View — Web AI host connection guide panel for the terminal dashboard.
 * Part of #523: Desktop App Web host connection guide.
 */

import { ANSI, truncate, pad, BOX, horizontalLine, stripAnsi } from '../ansi.js';
import type { ScreenSize } from '../types.js';
import { Renderer } from '../renderer.js';
import type { WebAIHostId, ConnectionInfo } from '../../connect/types.js';
import { generateConnectionInfo, getHostIds } from '../../connect/index.js';
import type { ServerConnectionState } from '../../connect/types.js';

export interface ConnectViewData {
  /** Currently selected host index */
  selectedIndex: number;
  /** Server connection state */
  serverState: ServerConnectionState;
  version: string;
}

const HOST_LABELS: Record<WebAIHostId, string> = {
  claude: 'Claude Web',
  chatgpt: 'ChatGPT',
  gemini: 'Gemini',
  custom: 'Other',
};

export class ConnectView {
  private renderer: Renderer;

  constructor(renderer: Renderer) {
    this.renderer = renderer;
  }

  render(data: ConnectViewData, size: ScreenSize): string[] {
    const lines: string[] = [];
    const width = size.columns;
    const hostIds = getHostIds();
    const selectedHost = hostIds[data.selectedIndex] || 'claude';
    const info = generateConnectionInfo(selectedHost, data.serverState);

    // Header
    lines.push(this.renderHeader(data.version, width));

    // Title
    lines.push(this.renderer.contentLine(
      `  ${ANSI.bold}Connect to Web AI${ANSI.reset}`,
      width,
    ));
    lines.push(this.renderer.emptyLine(width));

    // Platform selector
    lines.push(this.renderPlatformSelector(hostIds, data.selectedIndex, width));
    lines.push(this.renderer.emptyLine(width));

    // Connection info
    if (!data.serverState.tunnelUrl && !data.serverState.localUrl) {
      lines.push(this.renderer.contentLine(
        `  ${ANSI.yellow}Server not running. Start the server first.${ANSI.reset}`,
        width,
      ));
    } else {
      // URL display
      lines.push(this.renderSeparator('SERVER URL', width));
      lines.push(this.renderUrlLine(info, width));
      lines.push(this.renderer.emptyLine(width));

      // Tunnel status
      if (info.tunnelActive) {
        lines.push(this.renderer.contentLine(
          `  ${ANSI.green}● Tunnel active${ANSI.reset}`,
          width,
        ));
      } else {
        lines.push(this.renderer.contentLine(
          `  ${ANSI.yellow}● Local only${ANSI.reset} ${ANSI.dim}(start tunnel for web AI access)${ANSI.reset}`,
          width,
        ));
      }
      lines.push(this.renderer.emptyLine(width));

      // Bearer token (if set)
      if (info.bearerToken) {
        lines.push(this.renderSeparator('AUTH TOKEN', width));
        const masked = info.bearerToken.slice(0, 8) + '...' + info.bearerToken.slice(-4);
        lines.push(this.renderer.contentLine(
          `  ${ANSI.dim}Bearer ${masked}${ANSI.reset}`,
          width,
        ));
        lines.push(this.renderer.emptyLine(width));
      }

      // Settings URL
      if (info.settingsUrl) {
        lines.push(this.renderSeparator('SETTINGS', width));
        lines.push(this.renderer.contentLine(
          `  ${ANSI.blue}${ANSI.underline}${truncate(info.settingsUrl, width - 6)}${ANSI.reset}`,
          width,
        ));
        lines.push(this.renderer.emptyLine(width));
      }

      // Steps
      lines.push(this.renderSeparator('STEPS', width));
      for (let i = 0; i < info.steps.length; i++) {
        lines.push(this.renderer.contentLine(
          `  ${ANSI.bold}${i + 1}.${ANSI.reset} ${info.steps[i]}`,
          width,
        ));
      }
      lines.push(this.renderer.emptyLine(width));

      // Config snippet for custom
      if (selectedHost === 'custom') {
        lines.push(this.renderSeparator('JSON CONFIG', width));
        const snippetLines = info.configSnippet.split('\n');
        for (const sl of snippetLines) {
          lines.push(this.renderer.contentLine(
            `  ${ANSI.dim}${truncate(sl, width - 6)}${ANSI.reset}`,
            width,
          ));
        }
      }
    }

    // Fill remaining space
    while (lines.length < size.rows - 2) {
      lines.push(this.renderer.emptyLine(width));
    }

    // Key hints
    lines.push(this.renderSeparator('', width));
    lines.push(this.renderKeyHints(width));
    lines.push(this.renderer.footer(width));

    return lines;
  }

  private renderHeader(version: string, width: number): string {
    const title = `CONNECT — OpenChrome v${version}`;
    const leftPart = `${ANSI.bold}${ANSI.cyan} ${title}${ANSI.reset}`;
    const leftLen = title.length + 1;
    const middlePad = Math.max(0, width - leftLen - 2);
    return BOX.topLeft + leftPart + ' '.repeat(middlePad) + BOX.topRight;
  }

  private renderPlatformSelector(hostIds: WebAIHostId[], selectedIndex: number, width: number): string {
    const parts: string[] = [];
    for (let i = 0; i < hostIds.length; i++) {
      const label = HOST_LABELS[hostIds[i]];
      if (i === selectedIndex) {
        parts.push(`${ANSI.bgBlue}${ANSI.bold}${ANSI.white} ${label} ${ANSI.reset}`);
      } else {
        parts.push(`${ANSI.dim} ${label} ${ANSI.reset}`);
      }
    }
    const content = '  ' + parts.join(' ');
    return this.renderer.contentLine(content, width);
  }

  private renderUrlLine(info: ConnectionInfo, width: number): string {
    const url = truncate(info.serverUrl, width - 8);
    return this.renderer.contentLine(
      `  ${ANSI.bold}${ANSI.green}${url}${ANSI.reset}`,
      width,
    );
  }

  private renderSeparator(title: string, width: number): string {
    if (!title) {
      return BOX.teeRight + horizontalLine(width - 2) + BOX.teeLeft;
    }
    const titlePart = ` ${title} `;
    const remaining = width - titlePart.length - 2;
    return BOX.teeRight + titlePart + horizontalLine(remaining) + BOX.teeLeft;
  }

  private renderKeyHints(width: number): string {
    const hints = [
      `${ANSI.bold}[←→]${ANSI.reset}Platform`,
      `${ANSI.bold}[O]${ANSI.reset}pen Settings`,
      `${ANSI.bold}[Y]${ANSI.reset}Copy URL`,
      `${ANSI.bold}[Esc]${ANSI.reset}Back`,
      `${ANSI.bold}[Q]${ANSI.reset}uit`,
    ];
    return this.renderer.contentLine(' ' + hints.join('  '), width);
  }
}
