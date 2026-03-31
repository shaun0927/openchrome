/**
 * Cross-platform URL opener utility.
 * Part of #523: Desktop App Web host connection guide.
 */

import { execFile } from 'child_process';

export function openInBrowser(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      new URL(url);
    } catch {
      reject(new Error(`Invalid URL: ${url}`));
      return;
    }

    const platform = process.platform;
    let cmd: string;
    let args: string[];

    if (platform === 'darwin') {
      cmd = 'open';
      args = [url];
    } else if (platform === 'win32') {
      cmd = 'cmd';
      args = ['/c', 'start', '', url];
    } else {
      cmd = 'xdg-open';
      args = [url];
    }

    execFile(cmd, args, (error) => {
      if (error) {
        reject(new Error(`Failed to open browser: ${error.message}`));
        return;
      }
      resolve();
    });
  });
}
