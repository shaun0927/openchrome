/**
 * Display Detection Utility (#459)
 * Detects whether a graphical display is available for launching headed Chrome.
 */

import * as os from 'os';

/**
 * Returns true if the current environment has a display available for headed Chrome.
 * - macOS: always true (desktop session assumed when process is running)
 * - Windows: always true (desktop session assumed)
 * - Linux: checks $DISPLAY or $WAYLAND_DISPLAY environment variables
 */
export function hasDisplay(): boolean {
  const platform = os.platform();

  if (platform === 'darwin' || platform === 'win32') {
    return true;
  }

  // Linux: check for X11 or Wayland display
  if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) {
    return true;
  }

  return false;
}
