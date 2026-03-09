/// <reference types="jest" />

import { withDomDelta } from '../../src/utils/dom-delta';
import { generateVisualSummary } from '../../src/utils/visual-summary';
import { getPageDiagnostics, detectBlockingPage } from '../../src/utils/page-diagnostics';
import { createMockPage } from '../utils/mock-cdp';

// ─── withDomDelta ─────────────────────────────────────────────────────────────

describe('withDomDelta', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('returns delta string on successful action', async () => {
    const mockPage = createMockPage({ url: 'https://example.com' });

    // First evaluate call = inject observer (returns undefined)
    // Second evaluate call = collect delta script
    const collectedDelta = {
      urlChanged: false,
      newUrl: null,
      titleChanged: false,
      newTitle: null,
      scrollChanged: false,
      scroll: { x: 0, y: 0 },
      preScroll: { x: 0, y: 0 },
      mutations: [
        { type: 'added' as const, label: 'div', text: 'Hello world' },
        { type: 'removed' as const, label: 'span', text: 'Old content' },
      ],
    };

    (mockPage.evaluate as jest.Mock)
      .mockResolvedValueOnce(undefined)      // inject script
      .mockResolvedValueOnce(collectedDelta); // collect script

    const action = jest.fn().mockResolvedValue('action-result');

    const promise = withDomDelta(mockPage, action, { settleMs: 0 });
    await jest.runAllTimersAsync();
    const { result, delta } = await promise;

    expect(result).toBe('action-result');
    expect(action).toHaveBeenCalledTimes(1);
    expect(delta).toContain('[DOM Delta]');
    expect(delta).toContain('+ div');
    expect(delta).toContain('Hello world');
    expect(delta).toContain('- span');
    expect(delta).toContain('Old content');
  });

  test('reports navigation when URL changes', async () => {
    const mockPage = createMockPage({ url: 'https://example.com' });

    // url() returns different value after navigation
    (mockPage.url as jest.Mock)
      .mockReturnValueOnce('https://example.com')          // preUrl
      .mockReturnValueOnce('https://example.com/new-page'); // postUrl

    (mockPage.evaluate as jest.Mock)
      .mockResolvedValueOnce(undefined); // inject script succeeds

    (mockPage.title as jest.Mock).mockResolvedValue('New Page');

    const action = jest.fn().mockResolvedValue('nav-result');

    const promise = withDomDelta(mockPage, action, { settleMs: 0 });
    await jest.runAllTimersAsync();
    const { result, delta } = await promise;

    expect(result).toBe('nav-result');
    expect(delta).toContain('[Page navigated:');
    expect(delta).toContain('https://example.com/new-page');
  });

  test('returns empty delta on inject failure', async () => {
    const mockPage = createMockPage({ url: 'https://example.com' });

    // Inject script throws — withDomDelta catches and runs action directly
    (mockPage.evaluate as jest.Mock).mockRejectedValueOnce(new Error('page not ready'));

    const action = jest.fn().mockResolvedValue('fallback-result');

    const promise = withDomDelta(mockPage, action, { settleMs: 0 });
    await jest.runAllTimersAsync();
    const { result, delta } = await promise;

    expect(result).toBe('fallback-result');
    expect(action).toHaveBeenCalledTimes(1);
    expect(delta).toBe('');
  });

  test('returns empty delta on collect failure', async () => {
    const mockPage = createMockPage({ url: 'https://example.com' });

    (mockPage.evaluate as jest.Mock)
      .mockResolvedValueOnce(undefined)            // inject succeeds
      .mockRejectedValueOnce(new Error('collect failed')); // collect throws

    const action = jest.fn().mockResolvedValue('result');

    const promise = withDomDelta(mockPage, action, { settleMs: 0 });
    await jest.runAllTimersAsync();
    const { result, delta } = await promise;

    expect(result).toBe('result');
    expect(delta).toBe('');
  });
});

// ─── generateVisualSummary ────────────────────────────────────────────────────

describe('generateVisualSummary', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('returns formatted page state string', async () => {
    const mockPage = createMockPage({ url: 'https://example.com' });

    const pageState = {
      url: 'https://example.com/dashboard',
      title: 'Dashboard',
      scrollX: 0,
      scrollY: 250,
      scrollHeight: 3000,
      clientHeight: 800,
      panels: ['Welcome to the dashboard panel content here'],
      activeStates: [{ tag: 'button', text: 'Overview', qualifier: 'aria-selected' }],
      formState: [],
      headings: [
        { tag: 'h1', text: 'Dashboard' },
        { tag: 'h2', text: 'Recent Activity' },
      ],
      activeEl: null,
    };

    (mockPage.evaluate as jest.Mock).mockResolvedValue(pageState);

    const summaryPromise = generateVisualSummary(mockPage);
    await jest.runAllTimersAsync();
    const summary = await summaryPromise;

    expect(summary).toContain('[Page State]');
    expect(summary).toContain('https://example.com/dashboard');
    expect(summary).toContain('Dashboard');
    expect(summary).toContain('[Headings]');
    expect(summary).toContain('h1: "Dashboard"');
    expect(summary).toContain('h2: "Recent Activity"');
    expect(summary).toContain('[Selected]');
    expect(summary).toContain('button "Overview"');
    expect(summary).toContain('[Visible]');
    expect(summary).toContain('Panel 1:');
  });

  test('returns empty string on failure', async () => {
    const mockPage = createMockPage({ url: 'https://example.com' });

    (mockPage.evaluate as jest.Mock).mockRejectedValue(new Error('evaluate failed'));

    const summaryPromise = generateVisualSummary(mockPage);
    await jest.runAllTimersAsync();
    const summary = await summaryPromise;

    expect(summary).toBe('');
  });

  test('returns empty string on timeout', async () => {
    const mockPage = createMockPage({ url: 'https://example.com' });

    // Never resolves
    (mockPage.evaluate as jest.Mock).mockImplementation(
      () => new Promise<never>(() => {})
    );

    const summaryPromise = generateVisualSummary(mockPage);

    // Advance past the 3000ms timeout inside generateVisualSummary
    jest.advanceTimersByTime(3100);

    const summary = await summaryPromise;

    expect(summary).toBe('');
  });

  test('returns empty string when state is null', async () => {
    const mockPage = createMockPage({ url: 'https://example.com' });

    (mockPage.evaluate as jest.Mock).mockResolvedValue(null);

    const summaryPromise = generateVisualSummary(mockPage);
    await jest.runAllTimersAsync();
    const summary = await summaryPromise;

    expect(summary).toBe('');
  });
});

// ─── getPageDiagnostics ───────────────────────────────────────────────────────

describe('getPageDiagnostics', () => {
  test('returns diagnostics with element count', async () => {
    const mockPage = createMockPage({ url: 'https://example.com' });

    const diagnostics = {
      url: 'https://example.com',
      readyState: 'complete',
      totalElements: 142,
      framework: null,
      title: 'Example Domain',
    };

    (mockPage.evaluate as jest.Mock).mockResolvedValue(diagnostics);

    const result = await getPageDiagnostics(mockPage);

    expect(result.url).toBe('https://example.com');
    expect(result.readyState).toBe('complete');
    expect(result.totalElements).toBe(142);
    expect(result.framework).toBeNull();
    expect(result.title).toBe('Example Domain');
  });

  test('returns default values on failure', async () => {
    const mockPage = createMockPage({ url: 'https://example.com' });

    (mockPage.evaluate as jest.Mock).mockRejectedValue(new Error('page crashed'));

    const result = await getPageDiagnostics(mockPage);

    expect(result).toEqual({
      url: 'unknown',
      readyState: 'unknown',
      totalElements: 0,
      framework: null,
      title: 'unknown',
    });
  });

  test('detects React framework', async () => {
    const mockPage = createMockPage({ url: 'https://react-app.com' });

    const diagnostics = {
      url: 'https://react-app.com',
      readyState: 'complete',
      totalElements: 87,
      framework: 'react',
      title: 'My React App',
    };

    (mockPage.evaluate as jest.Mock).mockResolvedValue(diagnostics);

    const result = await getPageDiagnostics(mockPage);

    expect(result.framework).toBe('react');
  });
});

// ─── detectBlockingPage ───────────────────────────────────────────────────────

describe('detectBlockingPage', () => {
  test('detects CAPTCHA page', async () => {
    const mockPage = createMockPage({ url: 'https://example.com' });

    const blockingInfo = {
      type: 'captcha' as const,
      detail: 'Security Check',
    };

    (mockPage.evaluate as jest.Mock).mockResolvedValue(blockingInfo);

    const result = await detectBlockingPage(mockPage);

    expect(result).not.toBeNull();
    expect(result!.type).toBe('captcha');
    expect(result!.detail).toBe('Security Check');
  });

  test('returns null for normal pages', async () => {
    const mockPage = createMockPage({ url: 'https://example.com' });

    (mockPage.evaluate as jest.Mock).mockResolvedValue(null);

    const result = await detectBlockingPage(mockPage);

    expect(result).toBeNull();
  });
});
