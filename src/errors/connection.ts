/**
 * Typed connection error for OpenChrome.
 * Thrown when a CDP operation is attempted on a stale or invalid target.
 */
export class OpenChromeConnectionError extends Error {
  /** The target ID that was no longer valid, if available. */
  readonly targetId: string | undefined;

  constructor(message: string, targetId?: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'OpenChromeConnectionError';
    this.targetId = targetId;
  }
}

/**
 * Type guard for OpenChromeConnectionError instances.
 */
export function isOpenChromeConnectionError(error: unknown): error is OpenChromeConnectionError {
  return error instanceof OpenChromeConnectionError;
}
