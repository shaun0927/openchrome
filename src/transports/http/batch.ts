import { MCPErrorCodes, type MCPResponse } from '../../types/mcp';

export function createBatchTooLargeError(maxSize: number): MCPResponse {
  // id: null is the JSON-RPC 2.0 §5.1 sentinel for errors detected before a
  // request id can be parsed (or, here, any meaningful per-element id can be
  // chosen). It also avoids colliding with an active client-request id.
  return {
    jsonrpc: '2.0',
    id: null,
    error: {
      code: MCPErrorCodes.INVALID_REQUEST,
      message: `JSON-RPC batch size exceeds maximum of ${maxSize}`,
    },
  };
}

export async function mapBatchWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const workerCount = Math.min(concurrency, items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex++;
      results[currentIndex] = await fn(items[currentIndex]);
    }
  });

  await Promise.all(workers);
  return results;
}
