/**
 * crawl_cancel — mark a crawl job cancelled and return immediately (issue #886).
 *
 * The cancellation is sticky: subsequent `crawl_status({ advance > 0 })` calls
 * will see the cancelled status during JSONL replay and skip the runner.
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { loadJob, setStatus } from '../core/crawl/job-store';
import { emitCrawlTrace } from '../core/crawl/trace-emit';

const definition: MCPToolDefinition = {
  name: 'crawl_cancel',
  description:
    'Mark a crawl job as cancelled. Returns immediately. Subsequent ' +
    'crawl_status calls on this jobId will skip the runner and report ' +
    'status "cancelled".',
  inputSchema: {
    type: 'object',
    properties: {
      jobId: { type: 'string', description: 'Job id returned by crawl_start.' },
    },
    required: ['jobId'],
  },
};

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>,
): Promise<MCPResult> => {
  const jobId = args.jobId as string;
  if (!jobId || typeof jobId !== 'string') {
    return errorResult('jobId is required and must be a string');
  }
  try {
    // loadJob exists-check — surfaces a clear error rather than silently
    // appending to a non-existent file.
    loadJob(jobId);
  } catch (err) {
    return errorResult(`failed to load job ${jobId}: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    await setStatus(jobId, 'cancelled');
  } catch (err) {
    return errorResult(
      `failed to cancel ${jobId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  await emitCrawlTrace(sessionId, 'crawl_cancel', { jobId });
  const payload = { ok: true, status: 'cancelled' as const, jobId };
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    ...payload,
  };
};

function errorResult(message: string): MCPResult {
  return {
    content: [{ type: 'text', text: `crawl_cancel error: ${message}` }],
    isError: true,
  };
}

export function registerCrawlCancelTool(server: MCPServer): void {
  server.registerTool('crawl_cancel', handler, definition);
}
