import type { WindowBoundsConfig } from '../config/window-bounds';

const DEFAULT_HEADED_WINDOW_POSITION = { x: 0, y: 0 } as const;
const DEFAULT_HEADED_WINDOW_SIZE = { width: 1280, height: 900 } as const;

export function getHeadedWindowArgs(config: WindowBoundsConfig): string[] {
  const hasExplicitGeometry = Boolean(config.windowBounds || config.windowSize || config.windowPosition);

  if (config.startMaximized === true && !hasExplicitGeometry) {
    return ['--start-maximized'];
  }

  if (config.windowBounds) {
    return [
      `--window-position=${config.windowBounds.x},${config.windowBounds.y}`,
      `--window-size=${config.windowBounds.width},${config.windowBounds.height}`,
    ];
  }

  const position = config.windowPosition ?? DEFAULT_HEADED_WINDOW_POSITION;
  const size = config.windowSize ?? DEFAULT_HEADED_WINDOW_SIZE;
  return [
    `--window-position=${position.x},${position.y}`,
    `--window-size=${size.width},${size.height}`,
  ];
}
