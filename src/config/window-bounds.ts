export interface WindowSize {
  width: number;
  height: number;
}

export interface WindowPosition {
  x: number;
  y: number;
}

export interface WindowBounds extends WindowPosition, WindowSize {}

export interface WindowBoundsConfig {
  windowSize?: WindowSize;
  windowPosition?: WindowPosition;
  windowBounds?: WindowBounds;
  startMaximized?: boolean;
}

export interface WindowBoundsCliOptions {
  windowSize?: string;
  windowPosition?: string;
  windowBounds?: string;
  startMaximized?: boolean;
}

export interface WindowBoundsEnv {
  OPENCHROME_WINDOW_SIZE?: string;
  OPENCHROME_WINDOW_POSITION?: string;
  OPENCHROME_WINDOW_BOUNDS?: string;
  OPENCHROME_START_MAXIMIZED?: string;
}

export class WindowBoundsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WindowBoundsConfigError';
  }
}

function parseInteger(value: string, label: string): number {
  if (!/^-?\d+$/.test(value)) {
    throw new WindowBoundsConfigError(`${label} must be an integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new WindowBoundsConfigError(`${label} must be a safe integer`);
  }
  return parsed;
}

function parsePositiveInteger(value: string, label: string): number {
  if (!/^\d+$/.test(value)) {
    throw new WindowBoundsConfigError(`${label} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new WindowBoundsConfigError(`${label} must be a safe integer`);
  }
  if (parsed <= 0) {
    throw new WindowBoundsConfigError(`${label} must be greater than 0`);
  }
  return parsed;
}

function splitCsv(value: string, expectedParts: number, label: string): string[] {
  const parts = value.split(',').map((part) => part.trim());
  if (parts.length !== expectedParts || parts.some((part) => part.length === 0)) {
    throw new WindowBoundsConfigError(`${label} must be ${expectedParts} comma-separated integers`);
  }
  return parts;
}

function parseWindowSize(value: string, label: string): WindowSize {
  const [width, height] = splitCsv(value, 2, label);
  return {
    width: parsePositiveInteger(width, `${label} width`),
    height: parsePositiveInteger(height, `${label} height`),
  };
}

function parseWindowPosition(value: string, label: string): WindowPosition {
  const [x, y] = splitCsv(value, 2, label);
  return {
    x: parseInteger(x, `${label} x`),
    y: parseInteger(y, `${label} y`),
  };
}

function parseWindowBounds(value: string, label: string): WindowBounds {
  const [x, y, width, height] = splitCsv(value, 4, label);
  return {
    x: parseInteger(x, `${label} x`),
    y: parseInteger(y, `${label} y`),
    width: parsePositiveInteger(width, `${label} width`),
    height: parsePositiveInteger(height, `${label} height`),
  };
}

function parseBooleanEnv(value: string | undefined, label: string): boolean | undefined {
  if (value === undefined || value === '') return undefined;
  const normalized = value.toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'no') return false;
  throw new WindowBoundsConfigError(`${label} must be one of 1, true, yes, 0, false, or no`);
}

/**
 * Resolve headed Chrome window settings.
 *
 * Precedence:
 * 1. Resolve each setting from CLI first, then matching env var.
 * 2. Bounds override size/position.
 * 3. Any resolved geometry suppresses maximize.
 *
 * Bounds intentionally replace size/position. Any explicit geometry suppresses
 * maximize so Chrome does not ignore the requested placement.
 */
export function resolveWindowBoundsConfig(
  cli: WindowBoundsCliOptions,
  env: WindowBoundsEnv,
): WindowBoundsConfig {
  if (cli.windowBounds !== undefined) {
    return { windowBounds: parseWindowBounds(cli.windowBounds, '--window-bounds') };
  }

  if (cli.windowSize !== undefined || cli.windowPosition !== undefined) {
    return {
      ...(cli.windowSize !== undefined && { windowSize: parseWindowSize(cli.windowSize, '--window-size') }),
      ...(cli.windowPosition !== undefined && { windowPosition: parseWindowPosition(cli.windowPosition, '--window-position') }),
      ...(cli.windowSize === undefined && env.OPENCHROME_WINDOW_SIZE !== undefined && {
        windowSize: parseWindowSize(env.OPENCHROME_WINDOW_SIZE, 'OPENCHROME_WINDOW_SIZE'),
      }),
      ...(cli.windowPosition === undefined && env.OPENCHROME_WINDOW_POSITION !== undefined && {
        windowPosition: parseWindowPosition(env.OPENCHROME_WINDOW_POSITION, 'OPENCHROME_WINDOW_POSITION'),
      }),
      startMaximized: false,
    };
  }

  if (cli.startMaximized === true) {
    return { startMaximized: true };
  }

  if (env.OPENCHROME_WINDOW_BOUNDS !== undefined) {
    return { windowBounds: parseWindowBounds(env.OPENCHROME_WINDOW_BOUNDS, 'OPENCHROME_WINDOW_BOUNDS') };
  }

  if (env.OPENCHROME_WINDOW_SIZE !== undefined || env.OPENCHROME_WINDOW_POSITION !== undefined) {
    return {
      ...(env.OPENCHROME_WINDOW_SIZE !== undefined && {
        windowSize: parseWindowSize(env.OPENCHROME_WINDOW_SIZE, 'OPENCHROME_WINDOW_SIZE'),
      }),
      ...(env.OPENCHROME_WINDOW_POSITION !== undefined && {
        windowPosition: parseWindowPosition(env.OPENCHROME_WINDOW_POSITION, 'OPENCHROME_WINDOW_POSITION'),
      }),
      startMaximized: false,
    };
  }

  return {
    startMaximized: parseBooleanEnv(env.OPENCHROME_START_MAXIMIZED, 'OPENCHROME_START_MAXIMIZED') ?? false,
  };
}
