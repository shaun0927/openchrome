/**
 * Error raised when an in-flight tool call is aborted because the HTTP client
 * disconnected before the response was sent. Used as the AbortSignal `reason`
 * so downstream `cdpRace` calls can distinguish disconnect from other aborts.
 */
export class ClientDisconnectError extends Error {
  constructor(message = 'Client disconnected before tool call completed') {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'ClientDisconnectError';
  }
}

export function isClientDisconnect(error: unknown): error is ClientDisconnectError {
  return error instanceof ClientDisconnectError;
}
