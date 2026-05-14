import { pageReadyProbe, waitForPageReady } from '../../src/utils/page-ready-state';

describe('pageReadyProbe', () => {
  let originalDocument: any;
  let originalMutationObserver: any;

  beforeEach(() => {
    jest.useFakeTimers();
    originalDocument = (global as any).document;
    originalMutationObserver = (global as any).MutationObserver;
  });

  afterEach(() => {
    (global as any).document = originalDocument;
    (global as any).MutationObserver = originalMutationObserver;
    jest.useRealTimers();
  });

  function installDom(readyState = 'complete') {
    const listeners: Record<string, Function[]> = {};
    const doc = {
      readyState,
      documentElement: {},
      addEventListener: jest.fn((name: string, cb: Function) => {
        listeners[name] = listeners[name] || [];
        listeners[name].push(cb);
      }),
      removeEventListener: jest.fn(),
      __emit(name: string) {
        for (const cb of listeners[name] || []) cb();
      },
      __setReadyState(next: string) {
        this.readyState = next;
      },
    };
    (global as any).document = doc;
    return doc;
  }

  test('resolves after readyState is complete and quiet window passes', async () => {
    installDom('complete');
    const disconnect = jest.fn();
    (global as any).MutationObserver = jest.fn().mockImplementation(() => ({ observe: jest.fn(), disconnect }));

    const promise = pageReadyProbe({ timeoutMs: 1000, quietWindowMs: 100 });
    jest.advanceTimersByTime(99);
    await Promise.resolve();
    jest.advanceTimersByTime(1);

    await expect(promise).resolves.toMatchObject({ ready: true, timedOut: false, readyState: 'complete' });
    expect(disconnect).toHaveBeenCalled();
  });

  test('waits for interactive readyState before arming quiet window', async () => {
    const doc = installDom('loading');
    (global as any).MutationObserver = jest.fn().mockImplementation(() => ({ observe: jest.fn(), disconnect: jest.fn() }));

    const promise = pageReadyProbe({ timeoutMs: 1000, quietWindowMs: 50 });
    jest.advanceTimersByTime(100);
    doc.__setReadyState('interactive');
    doc.__emit('readystatechange');
    jest.advanceTimersByTime(50);

    await expect(promise).resolves.toMatchObject({ ready: true, timedOut: false, readyState: 'interactive' });
  });


  test('extends quiet window after observed mutations', async () => {
    installDom('complete');
    let mutationCallback: ((records: Array<{ type: string }>) => void) | undefined;
    (global as any).MutationObserver = jest.fn().mockImplementation((cb) => {
      mutationCallback = cb;
      return { observe: jest.fn(), disconnect: jest.fn() };
    });

    const promise = pageReadyProbe({ timeoutMs: 1000, quietWindowMs: 100 });
    jest.advanceTimersByTime(80);
    mutationCallback!([{ type: 'childList' }]);
    jest.advanceTimersByTime(99);
    await Promise.resolve();
    jest.advanceTimersByTime(1);

    await expect(promise).resolves.toMatchObject({ ready: true, timedOut: false, mutationsObserved: 1 });
  });

  test('returns timedOut when DOM never becomes ready', async () => {
    installDom('loading');
    (global as any).MutationObserver = jest.fn().mockImplementation(() => ({ observe: jest.fn(), disconnect: jest.fn() }));

    const promise = pageReadyProbe({ timeoutMs: 100, quietWindowMs: 50 });
    jest.advanceTimersByTime(100);

    await expect(promise).resolves.toMatchObject({ ready: false, timedOut: true });
  });
});

describe('waitForPageReady', () => {
  test('calls page.evaluate with bounded options', async () => {
    const page = {
      evaluate: jest.fn().mockResolvedValue({ ready: true, timedOut: false, readyState: 'complete', mutationsObserved: 0 }),
    } as any;

    const result = await waitForPageReady(page, { timeoutMs: 1234, quietWindowMs: 77 });

    expect(result).toMatchObject({ ready: true, timedOut: false, readyState: 'complete' });
    expect(result.elapsedMs).toEqual(expect.any(Number));
    expect(page.evaluate).toHaveBeenCalledWith(expect.any(Function), { timeoutMs: 1234, quietWindowMs: 77 });
  });

  test('settles timeout failures as timedOut readiness result', async () => {
    const page = { evaluate: jest.fn(() => new Promise(() => undefined)) } as any;
    const promise = waitForPageReady(page, { timeoutMs: 1, quietWindowMs: 1 });
    await expect(promise).resolves.toMatchObject({ ready: false, timedOut: true });
  });
});
