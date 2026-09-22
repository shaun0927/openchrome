import type { Browser, BrowserContext, CDPSession, Page } from 'puppeteer-core';
import { getTargetId } from './target-id';

const creationSessions = new WeakMap<Browser, Promise<CDPSession>>();

/** Create without activating the tab or its window; never retry in foreground. */
export async function createBackgroundPage(browser: Browser, context?: BrowserContext): Promise<Page> {
  let pending = creationSessions.get(browser);
  if (!pending) {
    pending = browser.target().createCDPSession();
    creationSessions.set(browser, pending);
    browser.once('disconnected', () => creationSessions.delete(browser));
    void pending.catch(() => creationSessions.delete(browser));
  }
  const session = await pending;
  let targetId: string | undefined;
  try {
    const created = await session.send('Target.createTarget', {
      url: 'about:blank',
      background: true,
      ...(context?.id ? { browserContextId: context.id } : {}),
    });
    targetId = created.targetId;
    const target = await browser.waitForTarget(t => getTargetId(t) === created.targetId, { timeout: 10000 });
    const page = await target.page();
    if (!page) throw new Error('Background target did not expose a page');
    return page;
  } catch (error) {
    if (targetId) {
      await session.send('Target.closeTarget', { targetId }).catch(cleanupError => {
        console.error('[BackgroundPage] Failed to close incomplete target:', cleanupError instanceof Error ? cleanupError.message : 'unknown error');
      });
    }
    throw error;
  }
}
