/**
 * Renderer - Screen rendering to stderr
 */

import { ANSI, moveTo, horizontalLine, BOX, stripAnsi, pad } from './ansi.js';
import type { ScreenSize } from './types.js';

export class Renderer {
  private lastFrame: string = '';
  private lastSize: ScreenSize = { columns: 80, rows: 24 };

  /**
   * Get current terminal size
   */
  getSize(): ScreenSize {
    const columns = process.stderr.columns || 80;
    const rows = process.stderr.rows || 24;
    this.lastSize = { columns, rows };
    return this.lastSize;
  }

  /**
   * Check if stderr is a TTY
   */
  isTTY(): boolean {
    return process.stderr.isTTY === true;
  }

  /**
   * Write to stderr
   */
  write(content: string): void {
    process.stderr.write(content);
  }

  /**
   * Clear the screen
   */
  clear(): void {
    this.write(ANSI.clear + ANSI.home);
    this.lastFrame = '';
  }

  /**
   * Hide cursor
   */
  hideCursor(): void {
    this.write(ANSI.hideCursor);
  }

  /**
   * Show cursor
   */
  showCursor(): void {
    this.write(ANSI.showCursor);
  }

  /**
   * Render a frame (with differential update support)
   */
  render(lines: string[]): void {
    const size = this.getSize();
    const frame = this.buildFrame(lines, size);

    // Only update if changed (simple comparison)
    if (frame !== this.lastFrame) {
      this.write(ANSI.home + frame);
      this.lastFrame = frame;
    }
  }

  /**
   * Force render without differential check
   */
  forceRender(lines: string[]): void {
    const size = this.getSize();
    const frame = this.buildFrame(lines, size);
    this.write(ANSI.home + frame);
    this.lastFrame = frame;
  }

  private buildFrame(lines: string[], size: ScreenSize): string {
    const output: string[] = [];

    for (let i = 0; i < size.rows; i++) {
      const line = lines[i] || '';
      const visibleLength = stripAnsi(line).length;

      if (visibleLength < size.columns) {
        // Pad to fill the line (to clear previous content)
        output.push(line + ' '.repeat(size.columns - visibleLength));
      } else if (visibleLength > size.columns) {
        // Truncate if too long
        output.push(this.truncateLine(line, size.columns));
      } else {
        output.push(line);
      }
    }

    return output.join('\n');
  }

  private truncateLine(line: string, maxWidth: number): string {
    // Handle ANSI codes properly
    let visibleLength = 0;
    let result = '';
    let inEscape = false;
    let escapeSeq = '';

    for (const char of line) {
      if (char === '\x1b') {
        inEscape = true;
        escapeSeq = char;
      } else if (inEscape) {
        escapeSeq += char;
        if (char === 'm') {
          result += escapeSeq;
          inEscape = false;
          escapeSeq = '';
        }
      } else {
        if (visibleLength >= maxWidth - 1) {
          result += '…';
          break;
        }
        result += char;
        visibleLength++;
      }
    }

    // Always reset at end
    result += ANSI.reset;

    return result;
  }

  /**
   * Create a box-style header line
   */
  header(text: string, width: number): string {
    const paddedText = ` ${text} `;
    const lineLength = width - paddedText.length - 2;
    const leftLine = Math.floor(lineLength / 2);
    const rightLine = lineLength - leftLine;

    return (
      BOX.topLeft +
      horizontalLine(leftLine) +
      ANSI.bold + paddedText + ANSI.reset +
      horizontalLine(rightLine) +
      BOX.topRight
    );
  }

  /**
   * Create a separator line
   */
  separator(width: number): string {
    return BOX.teeRight + horizontalLine(width - 2) + BOX.teeLeft;
  }

  /**
   * Create a footer line
   */
  footer(width: number): string {
    return BOX.bottomLeft + horizontalLine(width - 2) + BOX.bottomRight;
  }

  /**
   * Create a content line with borders
   */
  contentLine(content: string, width: number): string {
    const visibleLength = stripAnsi(content).length;
    const padding = Math.max(0, width - visibleLength - 2);
    return BOX.vertical + content + ' '.repeat(padding) + BOX.vertical;
  }

  /**
   * Create an empty line with borders
   */
  emptyLine(width: number): string {
    return BOX.vertical + ' '.repeat(width - 2) + BOX.vertical;
  }

  /**
   * Create a status badge
   */
  badge(text: string, color: string): string {
    return `${color}[${text}]${ANSI.reset}`;
  }

  /**
   * Create a progress indicator
   */
  spinner(frame: number): string {
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    return frames[frame % frames.length];
  }

  /**
   * Create a key hint
   */
  keyHint(key: string, description: string): string {
    return `${ANSI.bold}[${key}]${ANSI.reset}${description}`;
  }
}

// Singleton instance
let instance: Renderer | null = null;

export function getRenderer(): Renderer {
  if (!instance) {
    instance = new Renderer();
  }
  return instance;
}
