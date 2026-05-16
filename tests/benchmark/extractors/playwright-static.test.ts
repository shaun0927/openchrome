/// <reference types="jest" />

import { TOKEN_EFFICIENCY_CORPUS } from '../fixtures/token-efficiency/corpus';
import { computeRetention } from '../token-efficiency';
import { playwrightContentExtractor, playwrightInnerTextExtractor } from './playwright-static';

describe('fixture-backed Playwright token extractors', () => {
  const fixture = TOKEN_EFFICIENCY_CORPUS[0];

  test('content extractor measures raw fixture HTML without a live Chrome skip', () => {
    const result = playwrightContentExtractor.extract({
      html: fixture.html,
      groundTruth: fixture.groundTruth,
      liveAllowed: false,
    });
    expect(playwrightContentExtractor.liveOnly).toBe(false);
    expect(result?.payload).toBe(fixture.html);
    expect(computeRetention(result?.extracted ?? {}, fixture.groundTruth).retention).toBe(1);
  });

  test('innerText extractor measures rendered body text and preserves structured retention', () => {
    const result = playwrightInnerTextExtractor.extract({
      html: fixture.html,
      groundTruth: fixture.groundTruth,
      liveAllowed: false,
    });
    expect(playwrightInnerTextExtractor.liveOnly).toBe(false);
    expect(result?.payload?.length).toBeGreaterThan(0);
    expect(result?.payload).not.toContain('<html');
    expect(computeRetention(result?.extracted ?? {}, fixture.groundTruth).retention).toBe(1);
  });
});
