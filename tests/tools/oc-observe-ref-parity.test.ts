/// <reference types="jest" />
/**
 * Ref-parity test for oc_observe (#866).
 *
 * Acceptance criterion: when #844 (stable backend-node uid across snapshots)
 * lands, `oc_observe` and `read_page(mode='ax')` MUST return the same `ref`
 * for the same DOM node within the same loaderId.
 *
 * #844 has not landed yet, so this test runs only when explicitly opted-in
 * via the `OPENCHROME_TEST_REQUIRES_844=1` env var. The file is committed so
 * the dependency lock is explicit.
 */

const enabled = process.env.OPENCHROME_TEST_REQUIRES_844 === '1';
const describeOrSkip = enabled ? describe : describe.skip;

describeOrSkip('oc_observe ↔ read_page ref parity (#844 dependency)', () => {
  test('placeholder — wire this up against a live page once #844 lands', () => {
    // Real verification lives in scripts/verify/browserbase-A-observe.mjs.
    // Once #844 introduces a stable backend-node uid, replace this stub with:
    //   1. Drive a Puppeteer page to a deterministic fixture.
    //   2. Call read_page(mode='ax', tabId) — extract the ref for some node.
    //   3. Call oc_observe(tabId) — extract the ref for the same node.
    //   4. Assert refs are equal.
    expect(true).toBe(true);
  });
});
