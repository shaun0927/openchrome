/**
 * Cross-platform clipboard copy utility.
 * Part of #523: Desktop App Web host connection guide.
 */

import { execFile } from 'child_process';

const MAX_CLIPBOARD_BYTES = 100_000;

export function copyToClipboard(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (text.length > MAX_CLIPBOARD_BYTES) {
      reject(new Error(`Text too large for clipboard (${text.length} bytes, max ${MAX_CLIPBOARD_BYTES})`));
      return;
    }

    const platform = process.platform;
    let cmd: string;
    let args: string[];

    if (platform === 'darwin') {
      cmd = 'pbcopy';
      args = [];
    } else if (platform === 'win32') {
      cmd = 'clip';
      args = [];
    } else {
      cmd = 'xclip';
      args = ['-selection', 'clipboard'];
    }

    const child = execFile(cmd, args, { maxBuffer: 64 * 1024 }, (error) => {
      if (error) {
        if (platform === 'linux' && cmd === 'xclip') {
          const fallback = execFile('xsel', ['--clipboard', '--input'], { maxBuffer: 64 * 1024 }, (fallbackError) => {
            if (fallbackError) {
              reject(new Error('Clipboard copy failed: install xclip or xsel'));
              return;
            }
            resolve();
          });
          fallback.stdin?.write(text);
          fallback.stdin?.end();
          return;
        }
        reject(new Error(`Clipboard copy failed: ${error.message}`));
        return;
      }
      resolve();
    });

    child.stdin?.write(text);
    child.stdin?.end();
  });
}
