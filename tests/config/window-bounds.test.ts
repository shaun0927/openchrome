import {
  resolveWindowBoundsConfig,
  WindowBoundsConfigError,
} from '../../src/config/window-bounds';

describe('window bounds config resolver', () => {
  it('uses headed defaults indirectly by returning no geometry when nothing is set', () => {
    expect(resolveWindowBoundsConfig({}, {})).toEqual({ startMaximized: false });
  });

  it('parses CLI size and position', () => {
    expect(resolveWindowBoundsConfig(
      { windowSize: '1440,900', windowPosition: '-1440,0' },
      {},
    )).toEqual({
      windowSize: { width: 1440, height: 900 },
      windowPosition: { x: -1440, y: 0 },
      startMaximized: false,
    });
  });

  it('lets bounds override size and position', () => {
    expect(resolveWindowBoundsConfig(
      { windowBounds: '1280,0,640,900', windowSize: '1440,900', windowPosition: '0,0' },
      {},
    )).toEqual({
      windowBounds: { x: 1280, y: 0, width: 640, height: 900 },
    });
  });

  it('lets CLI options override matching env options', () => {
    expect(resolveWindowBoundsConfig(
      { windowSize: '1200,800', windowPosition: '5,6' },
      {
        OPENCHROME_WINDOW_SIZE: '300,400',
        OPENCHROME_WINDOW_POSITION: '10,20',
        OPENCHROME_START_MAXIMIZED: '1',
      },
    )).toEqual({
      windowSize: { width: 1200, height: 800 },
      windowPosition: { x: 5, y: 6 },
      startMaximized: false,
    });
  });

  it('can combine CLI and env geometry', () => {
    expect(resolveWindowBoundsConfig(
      { windowPosition: '5,6' },
      { OPENCHROME_WINDOW_SIZE: '1200,800' },
    )).toEqual({
      windowSize: { width: 1200, height: 800 },
      windowPosition: { x: 5, y: 6 },
      startMaximized: false,
    });
  });

  it('lets CLI geometry override env bounds while still filling missing geometry from env', () => {
    expect(resolveWindowBoundsConfig(
      { windowSize: '1200,800' },
      {
        OPENCHROME_WINDOW_BOUNDS: '1920,0,1280,900',
        OPENCHROME_WINDOW_POSITION: '5,6',
      },
    )).toEqual({
      windowSize: { width: 1200, height: 800 },
      windowPosition: { x: 5, y: 6 },
      startMaximized: false,
    });
  });

  it('lets CLI maximize override env geometry', () => {
    expect(resolveWindowBoundsConfig(
      { startMaximized: true },
      { OPENCHROME_WINDOW_SIZE: '1200,800' },
    )).toEqual({
      startMaximized: true,
    });
  });

  it('parses env bounds before env size and maximize', () => {
    expect(resolveWindowBoundsConfig(
      {},
      {
        OPENCHROME_WINDOW_BOUNDS: '1920,0,1280,900',
        OPENCHROME_WINDOW_SIZE: '800,600',
        OPENCHROME_START_MAXIMIZED: '1',
      },
    )).toEqual({
      windowBounds: { x: 1920, y: 0, width: 1280, height: 900 },
    });
  });

  it('rejects non-integer coordinates', () => {
    expect(() => resolveWindowBoundsConfig(
      { windowPosition: '1.5,0' },
      {},
    )).toThrow(WindowBoundsConfigError);
    expect(() => resolveWindowBoundsConfig(
      { windowPosition: '1.5,0' },
      {},
    )).toThrow('--window-position x must be an integer');
  });

  it('rejects non-positive dimensions', () => {
    expect(() => resolveWindowBoundsConfig(
      { windowSize: '1280,0' },
      {},
    )).toThrow('--window-size height must be greater than 0');
  });

  it('rejects unsafe integer dimensions', () => {
    expect(() => resolveWindowBoundsConfig(
      { windowSize: '9007199254740993,900' },
      {},
    )).toThrow('--window-size width must be a safe integer');
  });

  it('rejects malformed env booleans', () => {
    expect(() => resolveWindowBoundsConfig(
      {},
      { OPENCHROME_START_MAXIMIZED: 'maybe' },
    )).toThrow('OPENCHROME_START_MAXIMIZED must be one of');
  });
});
