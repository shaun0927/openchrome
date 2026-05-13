import type { MCPToolDefinition } from '../../types/mcp';
import { TOOL_ANNOTATIONS } from '../../types/tool-annotations';

export const createDefinition: MCPToolDefinition = {
  name: 'oc_pilot_handoff_create',
  category: 'pilot',
  annotations: TOOL_ANNOTATIONS.oc_pilot_handoff_create,
  description:
    'Pilot-tier: mint a single-use handoff token that lets another agent ' +
    'inherit the named browser session. In-memory only; process restart ' +
    'drops every active handoff. Gated by --pilot + handoff_persist family.',
  inputSchema: {
    type: 'object',
    properties: {
      session_id: {
        type: 'string',
        description: 'Browser session being transferred. Required.',
      },
      scope: {
        type: 'string',
        description:
          'Caller-defined scope label (e.g. "checkout", "read-only"). ' +
          'Surfaced back to the redeeming agent. Required.',
      },
      ttl_ms: {
        type: 'number',
        description:
          'Optional explicit TTL in ms. Defaults to 300000ms (5 min). ' +
          'Non-finite, zero, or negative values fall back to the default.',
      },
    },
    required: ['session_id', 'scope'],
  },
};

export const redeemDefinition: MCPToolDefinition = {
  name: 'oc_pilot_handoff_redeem',
  category: 'pilot',
  annotations: TOOL_ANNOTATIONS.oc_pilot_handoff_redeem,
  description:
    'Pilot-tier: redeem a single-use handoff token previously minted by ' +
    'oc_pilot_handoff_create. Consumes the record on success — subsequent ' +
    'calls with the same token return unknown_token. Gated by --pilot + ' +
    'handoff_persist family.',
  inputSchema: {
    type: 'object',
    properties: {
      token: {
        type: 'string',
        description: 'Token returned by oc_pilot_handoff_create.',
      },
    },
    required: ['token'],
  },
};

export const PILOT_HANDOFF_TOOL_DEFINITIONS: readonly MCPToolDefinition[] = [
  createDefinition,
  redeemDefinition,
] as const;
