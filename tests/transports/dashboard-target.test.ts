import { captureScreenshot } from '../../src/transports/http/dashboard-routes';
import { getScreenshotScheduler } from '../../src/cdp/screenshot-scheduler';
import { getBrowserLane } from '../../src/core/browser-lanes';
jest.mock('../../src/cdp/screenshot-scheduler', () => ({ getScreenshotScheduler: jest.fn() }));
jest.mock('../../src/core/browser-lanes', () => ({ getBrowserLane: jest.fn() }));

describe('dashboard explicit target observation', () => {
  const capture = jest.fn(async () => ({ data: 'image', durationMs: 1, waitMs: 0 }));
  const page = { isClosed: () => false };
  const manager = () => ({
    getAllSessionInfos: () => [{ id: 's', targetCount: 2, workers: [{ id: 'w' }] }],
    getWorker: () => ({ targets: new Set(['first', 'second']) }),
    getCDPClient: () => ({}),
    validateTargetOwnership: jest.fn((_session: string, target: string) => ['first', 'second'].includes(target)),
    getPage: jest.fn(async () => page),
  });
  beforeEach(() => { capture.mockClear(); (getScreenshotScheduler as jest.Mock).mockReturnValue({ capture }); });
  test('explicit target overrides insertion order and reports identity/freshness', async () => {
    const sm = manager();
    const result = await captureScreenshot(sm as never, 's', 'first');
    expect(sm.getPage).toHaveBeenCalledWith('s', 'first', undefined, 'page_screenshot');
    expect(result).toMatchObject({ targetId: 'first', sessionId: 's', selection: 'explicit', capturedAt: expect.any(Number) });
  });
  test('foreign/missing explicit target never falls back or captures', async () => {
    const sm = manager();
    await expect(captureScreenshot(sm as never, 's', 'foreign')).rejects.toThrow('unavailable');
    expect(sm.getPage).not.toHaveBeenCalled(); expect(capture).not.toHaveBeenCalled();
  });
  test('legacy selection is accurately labelled rather than claimed active', async () => {
    expect(await captureScreenshot(manager() as never, 's')).toMatchObject({
      targetId: 'second', selection: 'legacy-first-worker-latest-target',
    });
  });
  test('lane observation never selects a tab from another lane', async () => {
    (getBrowserLane as jest.Mock).mockReturnValue({ status: 'open', targetIds: ['first'] });
    const ref = { taskId: 'task', laneId: 'lane' };
    expect(await captureScreenshot(manager() as never, 's', undefined, ref)).toMatchObject({ ...ref, targetId: 'first', selection: 'task-lane' });
    expect(getBrowserLane).toHaveBeenCalledWith('task', 'lane', 's');
    capture.mockClear();
    await expect(captureScreenshot(manager() as never, 's', 'second', ref)).rejects.toThrow('does not belong');
    expect(capture).not.toHaveBeenCalled();
  });
});
