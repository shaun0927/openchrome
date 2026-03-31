/**
 * Cross-platform URL opener utility.
 * Part of #523: Desktop App Web host connection guide.
 */

import { exec } from 'child_process';

export function openInBrowser(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      new URL(url);
    } catch {
      reject(new Error(`Invalid URL: ${url}`));
      return;
    }

    const platform = process.platform;
    let command: string;

    if (platform === 'darwin') {
      command = `open "${url}"`;
    } else if (platform === 'win32') {
      command = `start "" "${url}"`;
    } else {
      command = `xdg-open "${url}"`;
    }

    exec(command, (error) => {
      if (error) {
        reject(new Error(`Failed to open browser: ${error.message}`));
        return;
      }
      resolve();
    });
  });
}
