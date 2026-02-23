/**
 * Memory Tools — 3 MCP tools for domain knowledge persistence.
 *
 * memory_record   — Agent stores knowledge after successful operations
 * memory_query    — Retrieve domain knowledge sorted by confidence
 * memory_validate — Agent reports success/failure after using knowledge
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getDomainMemory } from '../memory/domain-memory';

// ============================================
// memory_record
// ============================================

const recordDefinition: MCPToolDefinition = {
  name: 'memory_record',
  description: `Record domain knowledge for future reuse. Call this after discovering useful selectors, extraction strategies, or site-specific tips. The key should follow a naming convention like "selector:tweet", "tip:scroll_first", "avoid:read_page_for_extraction".`,
  inputSchema: {
    type: 'object',
    properties: {
      domain: {
        type: 'string',
        description: 'Website domain (e.g., "x.com", "amazon.com")',
      },
      key: {
        type: 'string',
        description: 'Knowledge key (e.g., "selector:tweet_container", "tip:infinite_scroll")',
      },
      value: {
        type: 'string',
        description: 'The knowledge value (e.g., "article[data-testid=\'tweet\']")',
      },
    },
    required: ['domain', 'key', 'value'],
  },
};

const recordHandler: ToolHandler = async (
  _sessionId: string,
  args: Record<string, unknown>
): Promise<MCPResult> => {
  const domain = args.domain as string;
  const key = args.key as string;
  const value = args.value as string;

  const entry = getDomainMemory().record(domain, key, value);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ id: entry.id, confidence: entry.confidence }, null, 2),
      },
    ],
  };
};

// ============================================
// memory_query
// ============================================

const queryDefinition: MCPToolDefinition = {
  name: 'memory_query',
  description: `Query stored domain knowledge. Returns entries sorted by confidence (highest first). Use before interacting with a site to leverage previously learned selectors and strategies.`,
  inputSchema: {
    type: 'object',
    properties: {
      domain: {
        type: 'string',
        description: 'Website domain to query (e.g., "x.com")',
      },
      key: {
        type: 'string',
        description: 'Optional key or key prefix to filter (e.g., "selector" returns all selector:* entries)',
      },
    },
    required: ['domain'],
  },
};

const queryHandler: ToolHandler = async (
  _sessionId: string,
  args: Record<string, unknown>
): Promise<MCPResult> => {
  const domain = args.domain as string;
  const key = args.key as string | undefined;

  const entries = getDomainMemory().query(domain, key);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ entries, count: entries.length }, null, 2),
      },
    ],
  };
};

// ============================================
// memory_validate
// ============================================

const validateDefinition: MCPToolDefinition = {
  name: 'memory_validate',
  description: `Validate domain knowledge after using it. Call with success=true when stored knowledge worked correctly, or success=false when it was outdated/broken. This adjusts confidence scores (+0.1 on success, -0.2 on failure).`,
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'The knowledge entry ID to validate',
      },
      success: {
        type: 'boolean',
        description: 'Whether the knowledge was accurate (true) or outdated/broken (false)',
      },
    },
    required: ['id', 'success'],
  },
};

const validateHandler: ToolHandler = async (
  _sessionId: string,
  args: Record<string, unknown>
): Promise<MCPResult> => {
  const id = args.id as string;
  const success = args.success as boolean;

  const entry = getDomainMemory().validate(id, success);

  if (!entry) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            id,
            pruned: true,
            message: 'Entry was pruned due to low confidence or not found',
          }, null, 2),
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
};

// ============================================
// Registration
// ============================================

export function registerMemoryTools(server: MCPServer): void {
  server.registerTool('memory_record', recordHandler, recordDefinition);
  server.registerTool('memory_query', queryHandler, queryDefinition);
  server.registerTool('memory_validate', validateHandler, validateDefinition);
}
