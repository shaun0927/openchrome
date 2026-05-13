/** Pilot MCP tool for local credential vault management. */
import { MCPServer } from '../../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../../types/mcp';
import { TOOL_ANNOTATIONS } from '../../types/tool-annotations';
import { getCredentialVaultStore, VaultError } from '../credentials/store';

const definition: MCPToolDefinition = {
  name: 'oc_credentials',
  description: 'Pilot credential vault. Stores values server-side and resolves vault://name references without echoing plaintext.',
  annotations: TOOL_ANNOTATIONS.oc_credentials,
  inputSchema: {
    type: 'object',
    properties: {
      subcommand: { type: 'string', enum: ['list', 'save', 'delete', 'rotate-key'], description: 'Vault operation to perform.' },
      name: { type: 'string', description: 'Credential name for save/delete.' },
      value: { type: 'string', description: 'Credential value for save. Never returned by list.' },
      newPassphrase: { type: 'string', description: 'Optional new passphrase for rotate-key.' },
    },
    required: ['subcommand'],
  },
};

function result(payload: Record<string, unknown>): MCPResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], ...payload };
}

const handler: ToolHandler = async (_sessionId, args): Promise<MCPResult> => {
  const store = getCredentialVaultStore();
  try {
    switch (args.subcommand) {
      case 'list': return result({ ok: true, credentials: await store.list() });
      case 'save':
        if (typeof args.name !== 'string' || typeof args.value !== 'string') return result({ ok: false, code: 'VAULT_BAD_ARGS', error: 'save requires string name and value', isError: true });
        await store.save(args.name, args.value);
        return result({ ok: true, name: args.name, token: `<vault:${args.name}>` });
      case 'delete':
        if (typeof args.name !== 'string') return result({ ok: false, code: 'VAULT_BAD_ARGS', error: 'delete requires string name', isError: true });
        return result({ ok: true, name: args.name, deleted: await store.delete(args.name) });
      case 'rotate-key':
        await store.rotateKey(typeof args.newPassphrase === 'string' ? args.newPassphrase : undefined);
        return result({ ok: true, rotated: true });
      default: return result({ ok: false, code: 'VAULT_BAD_ARGS', error: 'unknown subcommand', isError: true });
    }
  } catch (error) {
    const code = error instanceof VaultError ? error.code : 'VAULT_ERROR';
    return result({ ok: false, code, error: error instanceof Error ? error.message : String(error), isError: true });
  }
};

export function registerOcCredentialsTool(server: MCPServer): void { server.registerTool('oc_credentials', handler, definition); }
