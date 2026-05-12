jest.unmock('../../src/chrome/launcher');

import { getHeadedWindowArgs } from '../../src/chrome/launcher';

describe('headed Chrome window arguments', () => {
  it('defaults headed launches to fixed top-left bounds without maximize', () => {
    expect(getHeadedWindowArgs({})).toEqual([
      '--window-position=0,0',
      '--window-size=1280,900',
    ]);
  });

  it('uses explicit window bounds instead of size and position', () => {
    expect(getHeadedWindowArgs({
      windowBounds: { x: 1920, y: 0, width: 1280, height: 900 },
      windowSize: { width: 800, height: 600 },
      windowPosition: { x: 0, y: 0 },
      startMaximized: true,
    })).toEqual([
      '--window-position=1920,0',
      '--window-size=1280,900',
    ]);
  });

  it('starts maximized only when no explicit geometry is set', () => {
    expect(getHeadedWindowArgs({ startMaximized: true })).toEqual([
      '--start-maximized',
    ]);
  });

  it('suppresses maximize when size or position is explicit', () => {
    expect(getHeadedWindowArgs({
      windowSize: { width: 1400, height: 900 },
      startMaximized: true,
    })).toEqual([
      '--window-position=0,0',
      '--window-size=1400,900',
    ]);
  });
});
