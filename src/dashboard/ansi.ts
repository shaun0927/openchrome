/**
 * ANSI Escape Codes for Terminal Control
 */

export const ANSI = {
  // Screen control
  clear: '\x1b[2J',
  clearLine: '\x1b[2K',
  clearToEnd: '\x1b[0J',
  home: '\x1b[H',

  // Cursor control
  hideCursor: '\x1b[?25l',
  showCursor: '\x1b[?25h',
  saveCursor: '\x1b[s',
  restoreCursor: '\x1b[u',

  // Text styles
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',
  blink: '\x1b[5m',
  inverse: '\x1b[7m',
  reset: '\x1b[0m',

  // Foreground colors
  black: '\x1b[30m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',

  // Bright foreground colors
  brightBlack: '\x1b[90m',
  brightRed: '\x1b[91m',
  brightGreen: '\x1b[92m',
  brightYellow: '\x1b[93m',
  brightBlue: '\x1b[94m',
  brightMagenta: '\x1b[95m',
  brightCyan: '\x1b[96m',
  brightWhite: '\x1b[97m',

  // Background colors
  bgBlack: '\x1b[40m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
  bgCyan: '\x1b[46m',
  bgWhite: '\x1b[47m',
};

/**
 * Move cursor to specific position (1-indexed)
 */
export function moveTo(row: number, col: number): string {
  return `\x1b[${row};${col}H`;
}

/**
 * Move cursor up N lines
 */
export function moveUp(n: number = 1): string {
  return `\x1b[${n}A`;
}

/**
 * Move cursor down N lines
 */
export function moveDown(n: number = 1): string {
  return `\x1b[${n}B`;
}

/**
 * Move cursor right N columns
 */
export function moveRight(n: number = 1): string {
  return `\x1b[${n}C`;
}

/**
 * Move cursor left N columns
 */
export function moveLeft(n: number = 1): string {
  return `\x1b[${n}D`;
}

/**
 * Style text with ANSI codes
 */
export function style(text: string, ...styles: string[]): string {
  return styles.join('') + text + ANSI.reset;
}

/**
 * Truncate string to fit width, adding ellipsis if needed
 */
export function truncate(text: string, maxWidth: number): string {
  if (text.length <= maxWidth) {
    return text;
  }
  return text.slice(0, maxWidth - 1) + '…';
}

/**
 * Pad string to specific width
 */
export function pad(text: string, width: number, align: 'left' | 'right' | 'center' = 'left'): string {
  const visibleLength = stripAnsi(text).length;
  const padding = Math.max(0, width - visibleLength);

  switch (align) {
    case 'right':
      return ' '.repeat(padding) + text;
    case 'center':
      const leftPad = Math.floor(padding / 2);
      const rightPad = padding - leftPad;
      return ' '.repeat(leftPad) + text + ' '.repeat(rightPad);
    default:
      return text + ' '.repeat(padding);
  }
}

/**
 * Strip ANSI codes from string (for length calculations)
 */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Create a horizontal line
 */
export function horizontalLine(width: number, char: string = '─'): string {
  return char.repeat(width);
}

/**
 * Create a box border
 */
export const BOX = {
  topLeft: '┌',
  topRight: '┐',
  bottomLeft: '└',
  bottomRight: '┘',
  horizontal: '─',
  vertical: '│',
  teeRight: '├',
  teeLeft: '┤',
  teeDown: '┬',
  teeUp: '┴',
  cross: '┼',
};

/**
 * Format duration in ms to human readable string
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  if (ms < 60000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/**
 * Format uptime as HH:MM:SS
 */
export function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000) % 60;
  const minutes = Math.floor(ms / 60000) % 60;
  const hours = Math.floor(ms / 3600000);
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

/**
 * Format bytes to human readable string
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(0)}MB`;
}

/**
 * Format timestamp to HH:MM:SS
 */
export function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toTimeString().slice(0, 8);
}
