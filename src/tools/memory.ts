/**
 * Memory Tool — Consolidated domain knowledge persistence.
 *
 * Actions:
 *   record   — Store knowledge after discovering useful selectors/strategies
 *   query    — Retrieve domain knowledge sorted by confidence
 *   validate — Report success/failure after using knowledge
 *
 * Replaces: memory_record, memory_query, memory_validate
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getDomainMemory } from '../memory/domain-memory';

const definition: MCPToolDefinition = {
  name: 'memory',
  description:
    'Manage domain knowledge. Actions: "record" (store), "query" (retrieve by domain), "validate" (adjust confidence). Key convention: "selector:X", "tip:X", "avoid:X".',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['record', 'query', 'validate'],
        description: 'Action: record, query, or validate',
      },
      domain: {
        type: 'string',
        description: '(record, query) Domain, e.g. "x.com"',
      },
      key: {
        type: 'string',
        description:
          '(record) Key, e.g. "selector:tweet". (query) Key prefix filter.',
      },
      value: {
        type: 'string',
        description: '(record) Knowledge value, e.g. a CSS selector string',
      },
      id: {
        type: 'string',
        description: '(validate) Knowledge entry ID',
      },
      success: {
        type: 'boolean',
        description:
          '(validate) true = accurate, false = outdated/broken',
      },
    },
    required: ['action'],
  },
};

// ---------------------------------------------------------------------------
// Handlers per action
// ---------------------------------------------------------------------------

function handleRecord(args: Record<string, unknown>): MCPResult {
  const domain = args.domain as string;
  const key = args.key as string;
  const value = args.value as string;

  if (!domain || !key || !value) {
    return {
      content: [
        { type: 'text', text: 'Error: domain, key, and value are required for record action' },
      ],
      isError: true,
    };
  }

  const entry = getDomainMemory().record(domain, key, value);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ id: entry.id, confidence: entry.confidence }, null, 2),
      },
    ],
  };
}

function handleQuery(args: Record<string, unknown>): MCPResult {
  const domain = args.domain as string;
  const key = args.key as string | undefined;

  if (!domain) {
    return {
      content: [{ type: 'text', text: 'Error: domain is required for query action' }],
      isError: true,
    };
  }

  const entries = getDomainMemory().query(domain, key);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ entries, count: entries.length }, null, 2),
      },
    ],
  };
}

function handleValidate(args: Record<string, unknown>): MCPResult {
  const id = args.id as string;
  const success = args.success as boolean;

  if (!id || success === undefined || success === null) {
    return {
      content: [
        { type: 'text', text: 'Error: id and success are required for validate action' },
      ],
      isError: true,
    };
  }

  const entry = getDomainMemory().validate(id, success);

  if (!entry) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              id,
              pruned: true,
              message: 'Entry was pruned due to low confidence or not found',
            },
            null,
            2
          ),
        },
      ],
    };
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ id: entry.id, newConfidence: entry.confidence }, null, 2),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const handler: ToolHandler = async (
  _sessionId: string,
  args: Record<string, unknown>
): Promise<MCPResult> => {
  const action = args.action as string;

  switch (action) {
    case 'record':
      return handleRecord(args);
    case 'query':
      return handleQuery(args);
    case 'validate':
      return handleValidate(args);
    default:
      return {
        content: [
          {
            type: 'text',
            text: `Error: Unknown action "${action}". Use "record", "query", or "validate".`,
          },
        ],
        isError: true,
      };
  }
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerMemoryTools(server: MCPServer): void {
  server.registerTool('memory', handler, definition);
}
