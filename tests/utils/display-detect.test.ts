/// <reference types="jest" />
/**
 * Tests for Display Detection Utility (#459)
 */

describe('hasDisplay()', () => {
  let originalDisplay: string | undefined;
  let originalWayland: string | undefined;

  beforeEach(() => {
    originalDisplay = process.env.DISPLAY;
    originalWayland = process.env.WAYLAND_DISPLAY;
  });

  afterEach(() => {
    if (originalDisplay !== undefined) process.env.DISPLAY = originalDisplay;
    else delete process.env.DISPLAY;
    if (originalWayland !== undefined) process.env.WAYLAND_DISPLAY = originalWayland;
    else delete process.env.WAYLAND_DISPLAY;
    jest.restoreAllMocks();
    jest.resetModules();
  });

  test('returns true on macOS', async () => {
    jest.doMock('os', () => ({ ...jest.requireActual('os'), platform: () => 'darwin' }));
    const { hasDisplay } = await import('../../src/utils/display-detect');
    expect(hasDisplay()).toBe(true);
  });

  test('returns true on Windows', async () => {
    jest.doMock('os', () => ({ ...jest.requireActual('os'), platform: () => 'win32' }));
    const { hasDisplay } = await import('../../src/utils/display-detect');
    expect(hasDisplay()).toBe(true);
  });

  test('returns true on Linux with $DISPLAY set', async () => {
    jest.doMock('os', () => ({ ...jest.requireActual('os'), platform: () => 'linux' }));
    process.env.DISPLAY = ':0';
    delete process.env.WAYLAND_DISPLAY;
    const { hasDisplay } = await import('../../src/utils/display-detect');
    expect(hasDisplay()).toBe(true);
  });

  test('returns true on Linux with $WAYLAND_DISPLAY set', async () => {
    jest.doMock('os', () => ({ ...jest.requireActual('os'), platform: () => 'linux' }));
    delete process.env.DISPLAY;
    process.env.WAYLAND_DISPLAY = 'wayland-0';
    const { hasDisplay } = await import('../../src/utils/display-detect');
    expect(hasDisplay()).toBe(true);
  });

  test('returns false on Linux without display env vars', async () => {
    jest.doMock('os', () => ({ ...jest.requireActual('os'), platform: () => 'linux' }));
    delete process.env.DISPLAY;
    delete process.env.WAYLAND_DISPLAY;
    const { hasDisplay } = await import('../../src/utils/display-detect');
    expect(hasDisplay()).toBe(false);
  });
});
