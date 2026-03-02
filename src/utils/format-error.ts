/**
 * Safely extract an error message from an unknown thrown value.
 */
export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
