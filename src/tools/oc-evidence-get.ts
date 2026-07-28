/** Authorized retrieval for durable oc_assert evidence handles. */

import {
  AssertEvidenceStore,
  AssertEvidenceStoreError,
  getAssertEvidenceStore,
} from '../core/contracts/assert-evidence-store';
import { MCPServer } from '../mcp-server';
import { currentRequestContext } from '../observability/request-id';
import { DEFAULT_TENANT_ID } from '../tenant/types';
import type { MCPResult, MCPToolDefinition, ToolHandler } from '../types/mcp';
import { TOOL_ANNOTATIONS } from '../types/tool-annotations';

const definition: MCPToolDefinition = {
  name: 'oc_evidence_get',
  description:
    'Retrieve a durable oc_assert evidence artifact by handle. Retrieval is limited to the owning MCP session and tenant; expired, deleted, malformed, and unauthorized handles return stable error codes.',
  category: 'evidence',
  annotations: TOOL_ANNOTATIONS.oc_evidence_get,
  inputSchema: {
    type: 'object',
    properties: {
      evidence_handle: {
        type: 'string',
        description: 'REQUIRED Handle returned by oc_assert.',
      },
    },
  },
  outputSchema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['available', 'error'],
        description: 'Whether the authorized evidence artifact was returned.',
      },
      evidence_handle: {
        type: 'string',
        description: 'Requested evidence handle.',
      },
      created_at: {
        type: 'string',
        description: 'ISO timestamp when the artifact was persisted.',
      },
      expires_at: {
        type: 'string',
        description: 'ISO timestamp after which the handle is stale.',
      },
      artifact: {
        type: 'object',
        description: 'Redacted assertion evidence and provenance for an available handle.',
      },
      error: {
        type: 'object',
        description: 'Stable retrieval error for unavailable handles.',
      },
    },
    required: ['status', 'evidence_handle'],
  },
};

type EvidenceGetErrorCode =
  | 'EVIDENCE_HANDLE_REQUIRED'
  | 'EVIDENCE_HANDLE_MALFORMED'
  | 'EVIDENCE_NOT_FOUND'
  | 'EVIDENCE_EXPIRED'
  | 'EVIDENCE_FORBIDDEN'
  | 'EVIDENCE_CORRUPT';

const handlerFor = (store: AssertEvidenceStore): ToolHandler => async (
  sessionId,
  args,
  context,
): Promise<MCPResult> => {
  const rawHandle = args.evidence_handle;
  if (rawHandle === undefined || rawHandle === null || rawHandle === '') {
    return errorResult('', 'EVIDENCE_HANDLE_REQUIRED', 'evidence_handle is required');
  }
  if (typeof rawHandle !== 'string') {
    return errorResult('', 'EVIDENCE_HANDLE_MALFORMED', 'evidence_handle is malformed');
  }
  const handle = rawHandle;

  const tenantId = context?.principal?.tenantId
    ?? currentRequestContext()?.tenantId
    ?? DEFAULT_TENANT_ID;
  try {
    const artifact = store.loadAuthorized(handle, { sessionId, tenantId });
    return jsonResult({
      status: 'available',
      evidence_handle: handle,
      created_at: artifact.created_at,
      expires_at: artifact.expires_at,
      artifact,
    });
  } catch (error) {
    if (error instanceof AssertEvidenceStoreError) {
      const mapped = mapStoreError(error);
      return errorResult(handle, mapped.code, mapped.message);
    }
    return errorResult(handle, 'EVIDENCE_CORRUPT', 'evidence retrieval failed');
  }
};

function mapStoreError(error: AssertEvidenceStoreError): {
  code: EvidenceGetErrorCode;
  message: string;
} {
  switch (error.code) {
    case 'malformed_handle':
      return { code: 'EVIDENCE_HANDLE_MALFORMED', message: 'evidence_handle is malformed' };
    case 'not_found':
      return { code: 'EVIDENCE_NOT_FOUND', message: 'evidence handle was not found or was deleted' };
    case 'expired':
      return { code: 'EVIDENCE_EXPIRED', message: 'evidence handle has expired' };
    case 'forbidden':
      return { code: 'EVIDENCE_FORBIDDEN', message: 'evidence belongs to another session or tenant' };
    case 'corrupt':
      return { code: 'EVIDENCE_CORRUPT', message: 'evidence artifact is corrupt' };
  }
}

function errorResult(
  handle: string,
  code: EvidenceGetErrorCode,
  message: string,
): MCPResult {
  return jsonResult({
    status: 'error',
    evidence_handle: handle,
    error: { code, message },
  }, true);
}

function jsonResult(payload: Record<string, unknown>, isError = false): MCPResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    ...(isError ? { isError: true } : {}),
  };
}

export function registerOcEvidenceGetTool(
  server: MCPServer,
  store: AssertEvidenceStore = getAssertEvidenceStore(),
): void {
  server.registerTool('oc_evidence_get', handlerFor(store), definition);
}
