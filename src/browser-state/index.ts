/**
 * Browser State module — singleton access to the BrowserStateManager.
 * Gap 2 (#416): Browser State Snapshot & Restore.
 */

export { BrowserStateManager, BrowserSnapshot } from './snapshot';

import { BrowserStateManager } from './snapshot';

let instance: BrowserStateManager | null = null;

export function getBrowserStateManager(): BrowserStateManager {
  if (!instance) {
    instance = new BrowserStateManager();
  }
  return instance;
}
