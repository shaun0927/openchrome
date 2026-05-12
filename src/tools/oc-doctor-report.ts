/**
 * oc_doctor_report MCP tool
 * Reads the cached doctor report from ~/.openchrome/diagnostics/last-report.json.
 * Does NOT run new checks. Returns the most recent DoctorReport written by
 * `openchrome doctor`.
 *
 * Suppressible with OPENCHROME_DOCTOR_TOOL=0.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import type { DoctorReport } from '../cli/doctor';

const REPORT_PATH = path.join(os.homedir(), '.openchrome', 'diagnostics', 'last-report.json');

const definition: MCPToolDefinition = {
  name: 'oc_doctor_report',
  description: 'Read the most recent openchrome doctor diagnostic report from cache. Returns the DoctorReport written by the last `openchrome doctor` run. Does NOT trigger new checks — run `openchrome doctor` in a shell to refresh.',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

const handler: ToolHandler = async (): Promise<MCPResult> => {
  let stat: fs.Stats | null = null;
  try {
    stat = fs.statSync(REPORT_PATH);
  } catch {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ success: false, error: 'no_report', message: 'No cached doctor report found. Run `openchrome doctor` first.' }),
      }],
    };
  }

  let report: DoctorReport;
  try {
    const raw = fs.readFileSync(REPORT_PATH, 'utf8');
    report = JSON.parse(raw) as DoctorReport;
  } catch (err) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ success: false, error: 'parse_error', message: `Failed to parse doctor report: ${err instanceof Error ? err.message : String(err)}` }),
      }],
    };
  }

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        success: true,
        cachedAt: stat.mtimeMs,
        report,
      }),
    }],
  };
};

export function registerOcDoctorReportTool(server: MCPServer): void {
  if (process.env.OPENCHROME_DOCTOR_TOOL === '0') return;
  server.registerTool('oc_doctor_report', handler, definition);
}
