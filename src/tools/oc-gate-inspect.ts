/**
 * oc_gate_inspect — fact-only gate detection (B2-PR1 of #1359).
 *
 * Inspect the current tab for a *gate* — today, one of the CAPTCHA flavors
 * understood by `src/captcha/detect.ts`. Returns a structured fact record
 * describing what is present on the page; it **never** invokes any solver,
 * makes any third-party HTTP call, or asserts anything beyond what the DOM
 * directly observes.
 *
 * This is the host-side counterpart of #1359 Pillar C (facts before
 * decisions). The host agent reads the fact and decides:
 *
 *   - retry / back off,
 *   - ask the user to solve it interactively,
 *   - hand off to an external solver under the host's own credentials,
 *   - or give up and report the gate to the caller.
 *
 * Future PRs in the B2 thread extend the gate vocabulary (SSO redirect,
 * basic-auth, 2FA prompt, paywall). The tool name and output shape are
 * designed to absorb those additions without a breaking change — new
 * `gateType` values are simply added to the union, and `kind` discriminates
 * whether the gate is a captcha (sitekey present) or a different family.
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { TOOL_ANNOTATIONS } from '../types/tool-annotations';
import { getSessionManager } from '../session-manager';
import { detectCaptcha } from '../captcha/detect';
import type { CaptchaType } from '../types/captcha';

/**
 * High-level family of gate. Today only `captcha` is detected; the schema is
 * stable for the SSO/basic-auth/paywall extensions that land in B2-PR2.
 */
export type GateKind = 'captcha';

/**
 * Closed gate-type vocabulary. Adding a value here is a non-breaking change;
 * removing or renaming requires a tool version bump.
 */
export type GateType = CaptchaType;

export interface OcGateInspectOutput {
  detected: boolean;
  /** The gate family. Absent iff `detected === false`. */
  kind?: GateKind;
  /** Specific gate type (captcha flavor today). Absent iff `detected === false`. */
  gateType?: GateType;
  /** Captcha site key. Only present when a site key was extractable. */
  siteKey?: string;
  /** Provenance of the site key: which signal the detector read. */
  siteKeySource?: 'attribute' | 'script' | 'iframe';
  /** Whether the gate is invisible/background (captcha v3, invisible v2). */
  invisible?: boolean;
  /** The page URL observed at detection time. Always present. */
  pageUrl: string;
}

const definition: MCPToolDefinition = {
  name: 'oc_gate_inspect',
  description:
    'Detect whether the current tab is gated (CAPTCHA today; SSO/basic-auth/' +
    'paywall in follow-up PRs). Returns facts only — never invokes any ' +
    'solver, never makes a third-party HTTP call. The host agent decides ' +
    'what to do next.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'string',
        description: 'REQUIRED Tab ID to inspect.',
      },
    },
    required: ['tabId'],
  },
  annotations: TOOL_ANNOTATIONS.oc_gate_inspect,
};

function toResult(output: OcGateInspectOutput): MCPResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(output),
      },
    ],
  };
}

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>,
): Promise<MCPResult> => {
  const tabId = typeof args.tabId === 'string' ? args.tabId : '';
  if (!tabId) {
    return {
      content: [{ type: 'text', text: 'Error: tabId is required' }],
      isError: true,
    };
  }

  const sessionManager = getSessionManager();
  const page = await sessionManager.getPage(sessionId, tabId, undefined, 'oc_gate_inspect');
  if (!page) {
    return {
      content: [{ type: 'text', text: `Error: Tab ${tabId} not found` }],
      isError: true,
    };
  }

  let pageUrl = 'unknown';
  try {
    pageUrl = page.url();
  } catch {
    pageUrl = 'unknown';
  }

  const detection = await detectCaptcha(page);
  if (!detection) {
    return toResult({ detected: false, pageUrl });
  }

  const out: OcGateInspectOutput = {
    detected: true,
    kind: 'captcha',
    gateType: detection.captchaType,
    invisible: detection.invisible,
    pageUrl: detection.pageUrl || pageUrl,
  };
  if (detection.siteKey) {
    out.siteKey = detection.siteKey.key;
    out.siteKeySource = detection.siteKey.source;
  }
  return toResult(out);
};

export function registerOcGateInspectTool(server: MCPServer): void {
  server.registerTool('oc_gate_inspect', handler, definition);
}
