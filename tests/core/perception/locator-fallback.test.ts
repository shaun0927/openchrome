import {
  classifyLocatorFallbackTrigger,
  isLocatorFallbackEnabled,
  locatorFallbackThreshold,
  resolveLocatorFallback,
  setLocatorFallbackProviderForTests,
  type LocatorFallbackProvider,
} from '../../../src/core/perception/locator-fallback';

describe('locator fallback extension point', () => {
  afterEach(() => {
    setLocatorFallbackProviderForTests(null);
    delete process.env.OPENCHROME_LOCATOR_FALLBACK;
  });

  test('stays disabled by default and can be enabled by flag/env', () => {
    expect(isLocatorFallbackEnabled(undefined)).toBe(false);
    expect(isLocatorFallbackEnabled({ enabled: true })).toBe(true);
    process.env.OPENCHROME_LOCATOR_FALLBACK = '1';
    expect(isLocatorFallbackEnabled(undefined)).toBe(true);
    expect(isLocatorFallbackEnabled({ minConfidence: 0.8 })).toBe(true);
    expect(isLocatorFallbackEnabled({ enabled: false, minConfidence: 0.8 })).toBe(false);
  });

  test('maps stale, missing, ambiguous, and label mismatch triggers', () => {
    expect(classifyLocatorFallbackTrigger('STALE_REF: ref is stale')).toBe('STALE_REF');
    expect(classifyLocatorFallbackTrigger('No elements found matching Checkout')).toBe('ELEMENT_NOT_FOUND');
    expect(classifyLocatorFallbackTrigger('selector ambiguity: multiple candidates')).toBe('AMBIGUOUS_SELECTOR');
    expect(classifyLocatorFallbackTrigger('visible label mismatch')).toBe('VISIBLE_LABEL_MISMATCH');
  });

  test('validates provider candidates before accepting one', async () => {
    const provider: LocatorFallbackProvider = {
      name: 'fake-ai',
      async locate() {
        return {
          provider: 'fake-ai',
          candidates: [
            { provider: 'fake-ai', selector: '#hidden', confidence: 0.95, reason: 'label match' },
            { provider: 'fake-ai', selector: '#submit', confidence: 0.9, reason: 'button label match' },
          ],
        };
      },
    };

    const result = await resolveLocatorFallback(
      { trigger: 'ELEMENT_NOT_FOUND', query: 'Submit', tabId: 'tab-1', sessionId: 'sess-1' },
      async candidate => candidate.selector === '#submit'
        ? { ...candidate, selector: candidate.selector, rect: { x: 10, y: 20, width: 50, height: 20 } }
        : null,
      { provider, minConfidence: 0.7 },
    );

    expect(result.accepted?.selector).toBe('#submit');
    expect(result.rejected[0].reason).toContain('validation');
  });

  test('passes backendNodeId and ref-only candidates to validation', async () => {
    const provider: LocatorFallbackProvider = {
      name: 'fake-ai',
      async locate() {
        return {
          provider: 'fake-ai',
          candidates: [
            { provider: 'fake-ai', backendNodeId: 42, confidence: 0.9, reason: 'node match' },
            { provider: 'fake-ai', ref: 'ref_1', confidence: 0.8, reason: 'ref match' },
          ],
        };
      },
    };
    const validate = jest.fn(async candidate => (
      candidate.backendNodeId === 42
        ? { ...candidate, selector: 'backendNodeId:42', rect: { x: 10, y: 20, width: 50, height: 20 } }
        : null
    ));

    const result = await resolveLocatorFallback(
      { trigger: 'STALE_REF', query: 'Submit', tabId: 'tab-1', sessionId: 'sess-1' },
      validate,
      { provider, minConfidence: 0.7 },
    );

    expect(validate).toHaveBeenCalledWith(expect.objectContaining({ backendNodeId: 42 }));
    expect(result.accepted?.backendNodeId).toBe(42);
  });

  test('no-op provider fails gracefully without validated candidates', async () => {
    const result = await resolveLocatorFallback(
      { trigger: 'ELEMENT_NOT_FOUND', query: 'Submit', tabId: 'tab-1', sessionId: 'sess-1' },
      async () => { throw new Error('should not validate empty candidates'); },
      { minConfidence: locatorFallbackThreshold({ minConfidence: 0.8 }) },
    );

    expect(result.provider).toBe('noop');
    expect(result.accepted).toBeNull();
    expect(result.rejected).toEqual([]);
  });

  test('rejects candidates below confidence threshold without executing validation', async () => {
    const provider: LocatorFallbackProvider = {
      name: 'fake-ai',
      async locate() {
        return { provider: 'fake-ai', candidates: [{ provider: 'fake-ai', selector: '#submit', confidence: 0.2, reason: 'weak guess' }] };
      },
    };
    const validate = jest.fn();

    const result = await resolveLocatorFallback(
      { trigger: 'ELEMENT_NOT_FOUND', query: 'Submit', tabId: 'tab-1', sessionId: 'sess-1' },
      validate,
      { provider, minConfidence: 0.7 },
    );

    expect(result.accepted).toBeNull();
    expect(validate).not.toHaveBeenCalled();
    expect(result.rejected[0].reason).toContain('below threshold');
  });
});
