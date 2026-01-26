/**
 * Keyboard Handler - TTY keyboard input handling
 *
 * Note: Since stdin is used for MCP JSON-RPC, we read directly from /dev/tty
 */

import * as fs from 'fs';
import * as readline from 'readline';
import { EventEmitter } from 'events';

export type KeyCode =
  | 'p' | 'P'  // Pause/Resume
  | 's' | 'S'  // Sessions view
  | 't' | 'T'  // Tabs view
  | 'c' | 'C'  // Cancel
  | 'q' | 'Q'  // Quit
  | 'escape'   // Back to main view
  | 'up' | 'down' | 'left' | 'right'  // Navigation
  | 'enter'    // Select
  | 'space'    // Toggle
  | string;    // Other keys

export interface KeyEvent {
  key: KeyCode;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  raw: string;
}

export type KeyHandler = (event: KeyEvent) => void;

export class KeyboardHandler extends EventEmitter {
  private ttyFd: number | null = null;
  private ttyStream: fs.ReadStream | null = null;
  private rl: readline.Interface | null = null;
  private isRunning: boolean = false;
  private keyHandler: KeyHandler | null = null;

  /**
   * Check if TTY is available for keyboard input
   */
  static isAvailable(): boolean {
    try {
      // Check if /dev/tty exists and is accessible
      fs.accessSync('/dev/tty', fs.constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Start listening for keyboard input
   */
  start(handler: KeyHandler): boolean {
    if (this.isRunning) {
      return true;
    }

    this.keyHandler = handler;

    try {
      // Open /dev/tty for reading (bypasses stdin which is used for MCP)
      this.ttyFd = fs.openSync('/dev/tty', 'r');
      this.ttyStream = fs.createReadStream('', { fd: this.ttyFd });

      // Set raw mode if possible
      if (typeof (this.ttyStream as any).setRawMode === 'function') {
        (this.ttyStream as any).setRawMode(true);
      }

      this.rl = readline.createInterface({
        input: this.ttyStream,
        terminal: true,
      });

      // Enable keypress events
      readline.emitKeypressEvents(this.ttyStream, this.rl);

      this.ttyStream.on('keypress', (str: string, key: readline.Key) => {
        this.handleKeypress(str, key);
      });

      this.isRunning = true;
      this.emit('started');
      return true;
    } catch (error) {
      // TTY not available, running in non-interactive mode
      this.cleanup();
      return false;
    }
  }

  /**
   * Stop listening for keyboard input
   */
  stop(): void {
    if (!this.isRunning) {
      return;
    }

    this.cleanup();
    this.isRunning = false;
    this.emit('stopped');
  }

  private cleanup(): void {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }

    if (this.ttyStream) {
      // Restore raw mode if we set it
      if (typeof (this.ttyStream as any).setRawMode === 'function') {
        try {
          (this.ttyStream as any).setRawMode(false);
        } catch {
          // Ignore errors during cleanup
        }
      }
      this.ttyStream.destroy();
      this.ttyStream = null;
    }

    if (this.ttyFd !== null) {
      try {
        fs.closeSync(this.ttyFd);
      } catch {
        // Ignore errors during cleanup
      }
      this.ttyFd = null;
    }

    this.keyHandler = null;
  }

  private handleKeypress(str: string | undefined, key: readline.Key | undefined): void {
    if (!this.keyHandler) return;

    const event = this.parseKey(str, key);
    if (event) {
      this.keyHandler(event);
      this.emit('key', event);
    }
  }

  private parseKey(str: string | undefined, key: readline.Key | undefined): KeyEvent | null {
    const ctrl = key?.ctrl ?? false;
    const meta = key?.meta ?? false;
    const shift = key?.shift ?? false;
    const name = key?.name;
    const raw = str ?? '';

    // Handle special keys
    let keyCode: KeyCode;

    if (name === 'escape') {
      keyCode = 'escape';
    } else if (name === 'up') {
      keyCode = 'up';
    } else if (name === 'down') {
      keyCode = 'down';
    } else if (name === 'left') {
      keyCode = 'left';
    } else if (name === 'right') {
      keyCode = 'right';
    } else if (name === 'return') {
      keyCode = 'enter';
    } else if (name === 'space') {
      keyCode = 'space';
    } else if (raw) {
      keyCode = raw;
    } else if (name) {
      keyCode = name;
    } else {
      return null;
    }

    // Handle Ctrl+C for quit
    if (ctrl && keyCode === 'c') {
      keyCode = 'q'; // Treat Ctrl+C as quit
    }

    return {
      key: keyCode,
      ctrl,
      meta,
      shift,
      raw,
    };
  }

  /**
   * Check if keyboard handler is running
   */
  get running(): boolean {
    return this.isRunning;
  }
}

// Singleton instance
let instance: KeyboardHandler | null = null;

export function getKeyboardHandler(): KeyboardHandler {
  if (!instance) {
    instance = new KeyboardHandler();
  }
  return instance;
}
