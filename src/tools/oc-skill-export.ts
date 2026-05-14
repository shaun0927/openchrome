import path from 'node:path';

import { MCPServer } from '../mcp-server';
import { MCPResult, MCPToolDefinition, ToolHandler } from '../types/mcp';
import { TOOL_ANNOTATIONS } from '../types/tool-annotations';
import { codegenPath, defaultCodegenRoot, listCodegenFiles, type CodegenMode } from '../core/codegen';

const definition: MCPToolDefinition = {
  name: 'oc_skill_export',
  description: 'Export an opt-in codegen replay artifact written by --codegen. Returns the path and byte count for puppeteer, playwright, or mcp-replay output. Default OpenChrome behavior is unchanged when --codegen is off.',
  annotations: TOOL_ANNOTATIONS.oc_skill_recall,
  inputSchema: {
    type: 'object',
    properties: {
      skill_id: { type: 'string', description: 'Skill id or session id hint. For codegen artifacts this is matched against file names.' },
      session_id: { type: 'string', description: 'Exact MCP session id to export. Defaults to current session.' },
      format: { type: 'string', enum: ['puppeteer', 'playwright', 'mcp-replay'], description: 'REQUIRED Export format.' },
    },
    required: ['format'],
  },
};

const handler: ToolHandler = async (sessionId, args): Promise<MCPResult> => {
  const format = args.format as Exclude<CodegenMode, 'off'> | undefined;
  if (format !== 'puppeteer' && format !== 'playwright' && format !== 'mcp-replay') {
    return { isError: true, content: [{ type: 'text', text: 'oc_skill_export: format must be puppeteer, playwright, or mcp-replay' }] };
  }
  const sid = typeof args.session_id === 'string' ? args.session_id : sessionId;
  let file = codegenPath(sid, format);
  const files = listCodegenFiles(defaultCodegenRoot());
  if (!files.includes(file)) {
    const hint = typeof args.skill_id === 'string' ? args.skill_id : sid;
    const ext = format === 'mcp-replay' ? '.jsonl' : '.ts';
    const found = files.filter((f) => path.basename(f).includes(hint) && f.includes(`.${format}.`) && f.endsWith(ext)).pop();
    if (found) file = found;
  }
  try {
    const stat = await import('node:fs').then((fs) => fs.statSync(file));
    const payload = { path: file, byte_count: stat.size, format };
    return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
  } catch {
    return { isError: true, content: [{ type: 'text', text: `oc_skill_export: no ${format} codegen artifact found for session ${sid}` }] };
  }
};

export function registerOcSkillExportTool(server: MCPServer): void { server.registerTool(definition.name, handler, definition); }
export const __test__ = { definition, handler };
