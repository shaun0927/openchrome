import { extractDataHandler } from '../../src/tools/extract-data';
import { waitForPageReady } from '../../src/utils/page-ready-state';
import { getSessionManager } from '../../src/session-manager';

jest.mock('../../src/utils/page-ready-state', () => ({
  waitForPageReady: jest.fn(),
}));

jest.mock('../../src/session-manager', () => ({
  getSessionManager: jest.fn(),
}));

jest.mock('../../src/memory/domain-memory', () => ({
  extractDomainFromUrl: jest.fn(() => 'example.test'),
  getDomainMemory: jest.fn(() => ({ record: jest.fn() })),
}));

describe('extract_data waitForReady option', () => {
  const schema = { type: 'object', properties: { title: { type: 'string' } } };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  function installPage(evaluateResults: unknown[]) {
    const page = {
      url: jest.fn(() => 'https://example.test/product'),
      evaluate: jest.fn()
        .mockResolvedValueOnce(evaluateResults[0] ?? {})
        .mockResolvedValueOnce(evaluateResults[1] ?? {})
        .mockResolvedValueOnce(evaluateResults[2] ?? {})
        .mockResolvedValueOnce(evaluateResults[3] ?? {}),
    };
    (getSessionManager as jest.Mock).mockReturnValue({
      getPage: jest.fn().mockResolvedValue(page),
      getAvailableTargets: jest.fn().mockResolvedValue([]),
    });
    return page;
  }

  test('does not wait by default', async () => {
    installPage([{ title: 'JSON-LD title' }]);

    const result = await extractDataHandler('sess', { tabId: 'tab1', schema });
    const body = JSON.parse(result.content![0].text!);

    expect(waitForPageReady).not.toHaveBeenCalled();
    expect(body.readiness).toBeUndefined();
    expect(body.data.title).toBe('JSON-LD title');
  });

  test('waits before extraction when waitForReady is true', async () => {
    const readiness = { ready: true, timedOut: false, elapsedMs: 42, readyState: 'complete', mutationsObserved: 1 };
    (waitForPageReady as jest.Mock).mockResolvedValue(readiness);
    const page = installPage([{ title: 'Ready title' }]);

    const result = await extractDataHandler('sess', {
      tabId: 'tab1',
      schema,
      waitForReady: true,
      readyTimeoutMs: 2500,
    });
    const body = JSON.parse(result.content![0].text!);

    expect(waitForPageReady).toHaveBeenCalledWith(page, { timeoutMs: 2500 }, undefined);
    expect(body.readiness).toEqual(readiness);
    expect(body.data.title).toBe('Ready title');
  });

  test('includes timeout readiness metadata and still settles extraction', async () => {
    const readiness = { ready: false, timedOut: true, elapsedMs: 100, warning: 'page_ready timed out after 100ms' };
    (waitForPageReady as jest.Mock).mockResolvedValue(readiness);
    installPage([{}, {}, {}, {}]);

    const result = await extractDataHandler('sess', { tabId: 'tab1', schema, waitForReady: true, readyTimeoutMs: 100 });
    const body = JSON.parse(result.content![0].text!);

    expect(result.isError).toBeUndefined();
    expect(body.readiness).toEqual(readiness);
    expect(body.fieldsFound).toBe(0);
    expect(body.message).toContain('No data extracted');
  });
});
