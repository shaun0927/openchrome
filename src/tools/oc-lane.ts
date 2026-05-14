import { MCPServer } from '../mcp-server';
import { MCPResult, MCPToolDefinition, ToolHandler } from '../types/mcp';
import { TOOL_ANNOTATIONS } from '../types/tool-annotations';
import { closeBrowserLane, createBrowserLane, getBrowserLane, listBrowserLanes } from '../core/browser-lanes';

const laneShape: MCPToolDefinition['inputSchema'] = {
  type: 'object',
  properties: {
    taskId: { type: 'string', description: '16-hex task id returned by oc_task_start.' },
    task_id: { type: 'string', description: 'Alias for taskId.' },
    laneId: { type: 'string', description: 'Lane id returned by oc_lane_create.' },
    lane_id: { type: 'string', description: 'Alias for laneId.' },
  },
};

function jsonResult(payload: unknown): MCPResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], structuredContent: payload as Record<string, unknown> };
}
function err(message: string): MCPResult { return { isError: true, content: [{ type: 'text', text: message }] }; }
function taskId(args: Record<string, unknown>): string { return String(args.taskId ?? args.task_id ?? ''); }
function laneId(args: Record<string, unknown>): string { return String(args.laneId ?? args.lane_id ?? ''); }

const createDefinition: MCPToolDefinition = {
  name: 'oc_lane_create',
  description: 'Create a task-scoped browser lane backed by existing SessionManager worker/target primitives. Lanes isolate refs, tabs, and trace metadata for host-driven parallel work without spawning LLM subagents.',
  annotations: TOOL_ANNOTATIONS.oc_task_start,
  inputSchema: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'REQUIRED 16-hex task id returned by oc_task_start.' },
      task_id: { type: 'string', description: 'Alias for taskId.' },
      name: { type: 'string', description: 'Optional human label.' },
      purpose: { type: 'string', description: 'Optional bounded purpose for audit/debugging.' },
      initialUrl: { type: 'string', description: 'Optional URL to open as the first lane target.' },
      budget: { type: 'object', description: 'Optional host-owned lane budget metadata; recorded only.' },
    },
  },
};
const listDefinition: MCPToolDefinition = { name: 'oc_lane_list', description: 'List task-scoped browser lanes for a task.', annotations: TOOL_ANNOTATIONS.oc_task_list, inputSchema: laneShape };
const getDefinition: MCPToolDefinition = { name: 'oc_lane_get', description: 'Fetch one task-scoped browser lane including live target ids and counters.', annotations: TOOL_ANNOTATIONS.oc_task_get, inputSchema: laneShape };
const closeDefinition: MCPToolDefinition = { name: 'oc_lane_close', description: 'Close a task-scoped browser lane and its lane-owned targets without closing unrelated task tabs.', annotations: TOOL_ANNOTATIONS.oc_task_cancel, inputSchema: laneShape };

const createHandler: ToolHandler = async (sessionId, args) => {
  try {
    const tid = taskId(args);
    if (!tid) return err('oc_lane_create: taskId is required');
    const lane = await createBrowserLane({
      sessionId,
      taskId: tid,
      name: typeof args.name === 'string' ? args.name : undefined,
      purpose: typeof args.purpose === 'string' ? args.purpose : undefined,
      initialUrl: typeof args.initialUrl === 'string' ? args.initialUrl : undefined,
      budget: args.budget,
    });
    return jsonResult({ ok: true, lane });
  } catch (e) { return err(`oc_lane_create: ${e instanceof Error ? e.message : String(e)}`); }
};
const listHandler: ToolHandler = async (_sessionId, args) => {
  try { const tid = taskId(args); if (!tid) return err('oc_lane_list: taskId is required'); return jsonResult({ ok: true, lanes: listBrowserLanes(tid) }); }
  catch (e) { return err(`oc_lane_list: ${e instanceof Error ? e.message : String(e)}`); }
};
const getHandler: ToolHandler = async (_sessionId, args) => {
  try { const tid = taskId(args); const lid = laneId(args); if (!tid || !lid) return err('oc_lane_get: taskId and laneId are required'); return jsonResult({ ok: true, lane: getBrowserLane(tid, lid) }); }
  catch (e) { return err(`oc_lane_get: ${e instanceof Error ? e.message : String(e)}`); }
};
const closeHandler: ToolHandler = async (sessionId, args) => {
  try { const tid = taskId(args); const lid = laneId(args); if (!tid || !lid) return err('oc_lane_close: taskId and laneId are required'); return jsonResult({ ok: true, lane: await closeBrowserLane(tid, lid, sessionId) }); }
  catch (e) { return err(`oc_lane_close: ${e instanceof Error ? e.message : String(e)}`); }
};

export function registerOcLaneTools(server: MCPServer): void {
  server.registerTool(createDefinition.name, createHandler, createDefinition);
  server.registerTool(listDefinition.name, listHandler, listDefinition);
  server.registerTool(getDefinition.name, getHandler, getDefinition);
  server.registerTool(closeDefinition.name, closeHandler, closeDefinition);
}
export const __test__ = { createHandler, listHandler, getHandler, closeHandler };
