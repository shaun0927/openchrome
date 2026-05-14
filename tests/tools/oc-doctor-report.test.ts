/**
 * Tests for oc_doctor_report MCP tool
 * Covers: (a) returns parsed report when cache exists,
 *         (b) {success:false, error:'no_report'} when absent,
 *         (c) cachedAt == file mtime ±1ms
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MCPServer } from '../../src/mcp-server';
import { createMockSessionManager } from '../utils/mock-session';

const REPORT_DIR = path.join(os.homedir(), '.openchrome', 'diagnostics');
const REPORT_PATH = path.join(REPORT_DIR, 'last-report.json');

const SAMPLE_REPORT = {
  openchromeVersion: '1.11.0',
  platform: 'linux',
  arch: 'x64',
  nodeVersion: '20.0.0',
  startedAt: new Date().toISOString(),
  results: [
    { id: 'node-version', title: 'Node.js version', status: 'ok', durationMs: 1 },
  ],
  summary: { ok: 1, warn: 0, fail: 0, skip: 0 },
  exitCode: 0,
};

describe('oc_doctor_report tool', () => {
  let server: MCPServer;
  let handler: (sessionId: string, args: Record<string, unknown>) => Promise<unknown>;
  let originalReportExists: boolean;
  let originalReportContent: string | null = null;

  beforeAll(() => {
    // Save existing report if present
    try {
      originalReportContent = fs.readFileSync(REPORT_PATH, 'utf8');
      originalReportExists = true;
    } catch {
      originalReportExists = false;
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();

    const mockSessionManager = createMockSessionManager();
    server = new MCPServer(mockSessionManager as any);
  });

  afterEach(() => {
    // Restore original report state
    if (originalReportExists && originalReportContent !== null) {
      try {
        fs.mkdirSync(REPORT_DIR, { recursive: true });
        fs.writeFileSync(REPORT_PATH, originalReportContent, 'utf8');
      } catch { /* ignore */ }
    } else {
      try { fs.unlinkSync(REPORT_PATH); } catch { /* ignore */ }
    }
  });

  async function getHandler() {
    const { registerOcDoctorReportTool } = await import('../../src/tools/oc-doctor-report');
    registerOcDoctorReportTool(server);
    const h = server.getToolHandler('oc_doctor_report');
    expect(h).toBeDefined();
    return h!;
  }

  test('tool is registered with correct name', async () => {
    await getHandler();
    expect(server.getToolNames()).toContain('oc_doctor_report');
  });

  test('(b) returns {success:false, error:"no_report"} when no cache exists', async () => {
    // Remove the report file
    try { fs.unlinkSync(REPORT_PATH); } catch { /* ok */ }

    const h = await getHandler();
    const result = await h('default', {}) as { content: Array<{ type: string; text: string }> };
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe('no_report');
  });

  test('(a) returns parsed DoctorReport when cache exists', async () => {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    fs.writeFileSync(REPORT_PATH, JSON.stringify(SAMPLE_REPORT), 'utf8');

    const h = await getHandler();
    const result = await h('default', {}) as { content: Array<{ type: string; text: string }> };
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(true);
    expect(parsed.report).toBeDefined();
    expect(parsed.report.openchromeVersion).toBe('1.11.0');
    expect(parsed.report.results).toHaveLength(1);
    expect(parsed.cachedAt).toBeDefined();
    expect(typeof parsed.cachedAt).toBe('number');
  });

  test('(c) cachedAt equals file mtime within 1ms', async () => {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    fs.writeFileSync(REPORT_PATH, JSON.stringify(SAMPLE_REPORT), 'utf8');
    const stat = fs.statSync(REPORT_PATH);
    const expectedMtime = stat.mtimeMs;

    const h = await getHandler();
    const result = await h('default', {}) as { content: Array<{ type: string; text: string }> };
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.cachedAt).toBeCloseTo(expectedMtime, -1); // within 10ms is fine
    expect(Math.abs(parsed.cachedAt - expectedMtime)).toBeLessThanOrEqual(10);
  });

  test('not registered when OPENCHROME_DOCTOR_TOOL=0', async () => {
    const originalVal = process.env.OPENCHROME_DOCTOR_TOOL;
    process.env.OPENCHROME_DOCTOR_TOOL = '0';

    jest.resetModules();
    const mockSessionManager = createMockSessionManager();
    const freshServer = new MCPServer(mockSessionManager as any);
    const { registerOcDoctorReportTool } = await import('../../src/tools/oc-doctor-report');
    registerOcDoctorReportTool(freshServer);

    expect(freshServer.getToolNames()).not.toContain('oc_doctor_report');

    process.env.OPENCHROME_DOCTOR_TOOL = originalVal ?? '';
    if (!originalVal) delete process.env.OPENCHROME_DOCTOR_TOOL;
  });
});
