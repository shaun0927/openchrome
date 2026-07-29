/**
 * Internal control-flow error used to lift a legacy-style server-to-client
 * request into a 2026-07-28 input_required result.
 */
export class McpInputRequiredError extends Error {
  constructor(public readonly result: unknown) {
    super('mcp_input_required');
    this.name = 'McpInputRequiredError';
  }
}

export function isMcpInputRequiredError(error: unknown): error is McpInputRequiredError {
  return error instanceof McpInputRequiredError;
}
