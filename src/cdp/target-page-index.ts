import type { Page } from 'puppeteer-core';

/**
 * Small page lookup index for targetId → Puppeteer Page associations.
 *
 * It mirrors the Map surface CDPClient historically used, keeping the first
 * #687 Wave 4 extraction intentionally behavior-preserving while giving the
 * index a dedicated module for future lifecycle logic.
 */
export class TargetPageIndex {
  private readonly pages = new Map<string, Page>();

  get size(): number {
    return this.pages.size;
  }

  get(targetId: string): Page | undefined {
    return this.pages.get(targetId);
  }

  set(targetId: string, page: Page): this {
    this.pages.set(targetId, page);
    return this;
  }

  delete(targetId: string): boolean {
    return this.pages.delete(targetId);
  }

  has(targetId: string): boolean {
    return this.pages.has(targetId);
  }

  clear(): void {
    this.pages.clear();
  }
}
