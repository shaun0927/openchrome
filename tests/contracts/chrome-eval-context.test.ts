import { createChromeEvalContext } from '../../src/contracts/chrome-eval-context';

describe('createChromeEvalContext', () => {
  function makePage() {
    return {
      url: jest.fn(() => 'https://shop.example/cart'),
      evaluate: jest.fn(async (fn: Function, arg?: unknown) => {
        const body = { innerText: 'Cart ready Order Placed', textContent: 'Cart ready Order Placed' };
        const nodes = [{ innerText: 'Order Placed', textContent: 'Order Placed' }];
        const documentMock = {
          body,
          querySelector: (selector?: string) => selector === '.missing' ? null : nodes[0],
          querySelectorAll: (selector: string) => selector === '.item' ? [1, 2, 3] : [],
        };
        const previous = (global as any).document;
        (global as any).document = documentMock;
        try {
          return fn(arg);
        } finally {
          (global as any).document = previous;
        }
      }),
      screenshot: jest.fn(async () => Buffer.from('png-bytes')),
    };
  }

  it('exposes URL, DOM text/count, network entries, screenshot, and evidence hooks', async () => {
    const page = makePage();
    const ctx = createChromeEvalContext(page as any, {
      networkEntries: [
        { url: 'https://shop.example/old', status: 200, ts: 100 },
        { url: 'https://shop.example/new', status: 201, ts: 200 },
      ],
      networkMarkers: { contract_enter: 150 },
      screenshotPath: '/tmp/shot.png',
      traceWindow: { trace_id: 'trace-1', from_ts: 10, to_ts: 20 },
    });

    await expect(ctx.url()).resolves.toBe('https://shop.example/cart');
    await expect(ctx.domText(undefined)).resolves.toContain('Cart ready');
    await expect(ctx.domText('.missing')).resolves.toBeNull();
    await expect(ctx.domCount('.item')).resolves.toBe(3);
    await expect(ctx.networkSince('contract_enter')).resolves.toEqual([
      { url: 'https://shop.example/new', status: 201, ts: 200 },
    ]);
    await expect(ctx.screenshotPng()).resolves.toEqual(Buffer.from('png-bytes'));
    await expect(ctx.hasOpenDialog()).resolves.toBe(false);
    await expect(ctx.screenshotPath?.()).resolves.toBe('/tmp/shot.png');
    await expect(ctx.traceWindow?.()).resolves.toEqual({ trace_id: 'trace-1', from_ts: 10, to_ts: 20 });
  });

  it('returns null when screenshot capture fails', async () => {
    const page = makePage();
    page.screenshot.mockRejectedValueOnce(new Error('capture failed'));
    const ctx = createChromeEvalContext(page as any);
    await expect(ctx.screenshotPng()).resolves.toBeNull();
  });
});
