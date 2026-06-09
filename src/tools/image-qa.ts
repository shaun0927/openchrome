/**
 * image_qa — vision Q&A over a caller-supplied screenshot via MCP sampling
 * (issue #1432, Part 1).
 *
 * SSOT (#1359) alignment:
 *   - Host-neutral, MCP-first: the host LLM does the QA via
 *     `sampling/createMessage`. OpenChrome never owns its own API key.
 *   - Deterministic fallback when the client does not advertise the
 *     `sampling` capability: returns
 *     `{ status: 'unsupported_by_host', reason }`.
 *   - No auto-capture. The caller MUST pass an existing screenshot
 *     reference (file path, base64 blob, or in-memory ref). The tool only
 *     reads bytes that some other tool already produced.
 *
 * Out of scope (Part 2 of #1432):
 *   - Wiring `oc_assert` to cite an `image_qa` clause as evidence.
 */

import * as fs from 'node:fs';

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolContext, ToolHandler } from '../types/mcp';
import { TOOL_ANNOTATIONS } from '../types/tool-annotations';
import { coerceSupportedImageMimeType, makeImageContent } from '../utils/image-mime';

interface ImageQaScreenshot {
  /** Opaque in-memory reference produced by a sibling tool. */
  ref?: string;
  /** Absolute path to a PNG/JPEG file. */
  path?: string;
  /** Base64-encoded screenshot bytes. */
  base64?: string;
  /** Optional explicit mime type. Defaults to `image/png`. */
  mime_type?: string;
}

interface ImageQaInput {
  screenshot?: ImageQaScreenshot;
  question?: string;
  max_tokens?: number;
}

type ImageQaOutput =
  | {
      status: 'ok';
      answer: string;
      model?: string;
      usage?: Record<string, unknown>;
    }
  | {
      status: 'unsupported_by_host';
      reason: string;
    }
  | {
      status: 'error';
      reason: string;
    };

const definition: MCPToolDefinition = {
  name: 'image_qa',
  description:
    'Ask the connected host LLM a question about a caller-supplied ' +
    'screenshot. Forwards via MCP `sampling/createMessage` when the client ' +
    'advertises the `sampling` capability. Returns ' +
    '`{ status: "unsupported_by_host", reason }` when the capability is ' +
    'absent — OpenChrome never uses its own API keys. The caller MUST ' +
    'supply one of `screenshot.ref`, `screenshot.path`, or ' +
    '`screenshot.base64`. No auto-capture.',
  annotations: TOOL_ANNOTATIONS.image_qa,
  inputSchema: {
    type: 'object',
    properties: {
      screenshot: {
        type: 'object',
        description:
          'REQUIRED Exactly one of `ref`, `path`, or `base64` must be supplied. ' +
          'Optional `mime_type` defaults to `image/png`.',
        properties: {
          ref: {
            type: 'string',
            description: 'Opaque reference from a sibling tool.',
          },
          path: {
            type: 'string',
            description: 'Absolute path to a PNG/JPEG screenshot file.',
          },
          base64: {
            type: 'string',
            description: 'Base64-encoded screenshot bytes.',
          },
          mime_type: {
            type: 'string',
            description: 'MIME type. Defaults to image/png.',
          },
        },
      },
      question: {
        type: 'string',
        description: 'REQUIRED Vision Q&A prompt for the host LLM.',
      },
      max_tokens: {
        type: 'number',
        description: 'Optional sampling cap. Defaults to 512.',
      },
    },
    required: ['screenshot', 'question'],
  },
};

function jsonResult(payload: ImageQaOutput): MCPResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

function readBase64(screenshot: ImageQaScreenshot): { base64: string; mime: string } | { error: string } {
  const mime = screenshot.mime_type ?? 'image/png';
  // Exactly-one validation: count provided sources.
  const provided = [
    screenshot.ref ?? null,
    screenshot.path ?? null,
    screenshot.base64 ?? null,
  ].filter((v) => v != null && v !== '').length;
  if (provided !== 1) {
    return { error: 'screenshot must contain exactly one of `ref`, `path`, or `base64`' };
  }
  if (screenshot.base64) {
    return { base64: screenshot.base64, mime };
  }
  if (screenshot.path) {
    try {
      const bytes = fs.readFileSync(screenshot.path);
      return { base64: bytes.toString('base64'), mime };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `cannot read screenshot.path: ${message}` };
    }
  }
  // ref-based screenshots: the contract is opaque — the host that produced
  // the ref is responsible for resolving it. For Part 1 we surface a clear
  // unsupported result rather than guessing.
  return { error: 'screenshot.ref resolution is not supported yet — pass `path` or `base64`' };
}

const handler: ToolHandler = async (
  _sessionId: string,
  args: Record<string, unknown>,
  context?: ToolContext,
): Promise<MCPResult> => {
  const input = args as ImageQaInput;
  const screenshot = input.screenshot;
  const question = input.question;
  const maxTokens = typeof input.max_tokens === 'number' ? Math.max(1, Math.floor(input.max_tokens)) : 512;

  if (!screenshot || typeof screenshot !== 'object') {
    return jsonResult({ status: 'error', reason: 'missing required field: screenshot' });
  }
  if (typeof question !== 'string' || question.trim().length === 0) {
    return jsonResult({ status: 'error', reason: 'missing required field: question' });
  }

  const decoded = readBase64(screenshot);
  if ('error' in decoded) {
    return jsonResult({ status: 'error', reason: decoded.error });
  }

  const samplingCap = context?.clientCapabilities?.sampling;
  if (!samplingCap) {
    return jsonResult({
      status: 'unsupported_by_host',
      reason: 'sampling capability not advertised by client',
    });
  }
  if (!context?.requestClient) {
    return jsonResult({
      status: 'unsupported_by_host',
      reason: 'requestClient bridge not available on this transport',
    });
  }

  type SamplingResponse = {
    content?: { type?: string; text?: string };
    model?: string;
    usage?: Record<string, unknown>;
  };

  try {
    const response = await context.requestClient<SamplingResponse>(
      'sampling/createMessage',
      {
        messages: [
          {
            role: 'user',
            content: [
              makeImageContent(decoded.base64, coerceSupportedImageMimeType(decoded.mime)),
              { type: 'text', text: question },
            ],
          },
        ],
        maxTokens,
        // The host decides which model to use; we do not impose one.
      },
      { timeoutMs: 30_000 },
    );

    const answer =
      typeof response?.content?.text === 'string'
        ? response.content.text
        : '';

    return jsonResult({
      status: 'ok',
      answer,
      ...(response?.model ? { model: response.model } : {}),
      ...(response?.usage ? { usage: response.usage } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonResult({ status: 'error', reason: `sampling request failed: ${message}` });
  }
};

export function registerImageQaTool(server: MCPServer): void {
  server.registerTool('image_qa', handler, definition);
}

/**
 * Internal helper exposed for runtime wiring (e.g. the oc_assert
 * contract evaluator's `imageQaSample` hook, #1432 Part 2 runtime
 * follow-up). Takes a pre-decoded base64 screenshot, forwards to the
 * host via MCP sampling when available, and returns a structured
 * `{ status: 'ok', answer }` or `{ status: 'unsupported_by_host', reason }`.
 *
 * Does NOT register a tool — call it directly from another tool's
 * handler, threading through the caller's ToolContext so the host
 * capability lookup and requestClient bridge are honoured.
 */
export async function runImageQaSampling(
  ctx: ToolContext | undefined,
  params: { question: string; base64: string; mime?: string; maxTokens?: number },
): Promise<
  | { status: 'ok'; answer: string; model?: string; usage?: Record<string, unknown> }
  | { status: 'unsupported_by_host'; reason: string }
  | { status: 'error'; reason: string }
> {
  const samplingCap = ctx?.clientCapabilities?.sampling;
  if (!samplingCap) {
    return {
      status: 'unsupported_by_host',
      reason: 'sampling capability not advertised by client',
    };
  }
  if (!ctx?.requestClient) {
    return {
      status: 'unsupported_by_host',
      reason: 'requestClient bridge not available on this transport',
    };
  }

  type SamplingResponse = {
    content?: { type?: string; text?: string };
    model?: string;
    usage?: Record<string, unknown>;
  };

  try {
    const response = await ctx.requestClient<SamplingResponse>(
      'sampling/createMessage',
      {
        messages: [
          {
            role: 'user',
            content: [
              makeImageContent(params.base64, coerceSupportedImageMimeType(params.mime)),
              { type: 'text', text: params.question },
            ],
          },
        ],
        maxTokens: params.maxTokens ?? 512,
      },
      { timeoutMs: 30_000 },
    );
    // A non-text content block (e.g. the host echoes back an image) has
    // no answer to match. Treat it as a transport-level error so the
    // caller degrades to inconclusive rather than matching the regex
    // against an empty string (which a permissive pattern would pass).
    if (response?.content?.type !== 'text' || typeof response.content.text !== 'string') {
      return { status: 'error', reason: 'sampling response was not a text content block' };
    }
    const answer = response.content.text;
    return {
      status: 'ok',
      answer,
      ...(response?.model ? { model: response.model } : {}),
      ...(response?.usage ? { usage: response.usage } : {}),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: 'error', reason: `sampling request failed: ${message}` };
  }
}
