/**
 * Cross-platform clipboard copy utility.
 * Part of #523: Desktop App Web host connection guide.
 */

import { exec } from 'child_process';

export function copyToClipboard(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const platform = process.platform;
    let command: string;

    if (platform === 'darwin') {
      command = 'pbcopy';
    } else if (platform === 'win32') {
      command = 'clip';
    } else {
      command = 'xclip -selection clipboard';
    }

    const child = exec(command, (error) => {
      if (error) {
        if (platform === 'linux' && command.startsWith('xclip')) {
          const fallback = exec('xsel --clipboard --input', (fallbackError) => {
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
