import type { Page } from 'puppeteer-core';
import type { AnnotatedScreenshotResult, AnnotationOptions, PerceptionSnapshot } from '../types';
import { analyzeScreenshot } from '../screenshot-analyzer';
import { buildPerceptionSnapshotFromAnnotatedResult, type PerceptionProviderOptions } from '../perception-provider';

export interface DomAnnotatorCaptureResult {
  result: AnnotatedScreenshotResult;
  snapshot: PerceptionSnapshot;
}

export class DomAnnotatorPerceptionProvider {
  readonly name = 'dom-annotator';

  constructor(private readonly page: Page) {}

  async capture(
    tabId: string,
    url: string,
    options?: PerceptionProviderOptions & AnnotationOptions
  ): Promise<PerceptionSnapshot> {
    return (await this.captureAnnotated(tabId, url, options)).snapshot;
  }

  async captureAnnotated(
    tabId: string,
    url: string,
    options?: PerceptionProviderOptions & AnnotationOptions
  ): Promise<DomAnnotatorCaptureResult> {
    const result = await analyzeScreenshot(this.page, options);
    const snapshot = buildPerceptionSnapshotFromAnnotatedResult(result, {
      provider: this.name,
      tabId,
      url,
      maxElements: options?.maxElements,
      maxLabelLength: options?.maxLabelLength,
    });
    return { result, snapshot };
  }
}
