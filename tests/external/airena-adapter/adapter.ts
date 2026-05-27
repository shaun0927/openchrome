/**
 * adapter.ts — sample wire-up for airena.lol benchmark scoring.
 *
 * Demonstrates how an external benchmark adapter calls openchrome's
 * public MCP surfaces, composes the resulting facts via
 * `mapToAirenaRound`, and POSTs the round envelope to airena's REST
 * endpoint.
 *
 * SAMPLE ONLY. This file is not on the openchrome build graph, has no
 * test coverage of its transport layer, and is not invoked by any
 * benchmark suite. The load-bearing surface is `map-to-airena.ts`
 * (pure function, fully tested). Forking this directory and swapping
 * the mapper is the recommended path for other external scorers.
 *
 * Per #1359 §P1 (host-neutral MCP first): openchrome emits facts; the
 * adapter turns facts into a host-specific REST shape. The boundary
 * is the MCP tool API — nothing in this file reaches into openchrome
 * internals.
 */

import { mapToAirenaRound } from './map-to-airena';

/**
 * Minimal MCP client interface — the adapter accepts any client that
 * can call openchrome tools by name. In practice this is whichever
 * MCP client library the host already uses.
 */
export interface OpenChromeMcp {
  call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown> | undefined>;
}

export interface AirenaConfig {
  apiBaseUrl: string;
  apiKey: string;
  round?: string;
}

export interface AirenaTemplate {
  id: string;
  version: number;
  targetSchema: { format: string; definition: unknown };
}

export interface RoundContext {
  tabId: string;
  targetUrl: string;
  template: AirenaTemplate;
}

/**
 * Run a single airena round against the active openchrome tab and
 * POST the result. Returns the airena server response on success;
 * throws on transport failure (the caller decides whether to retry).
 */
export async function runAirenaRound(
  mcp: OpenChromeMcp,
  airena: AirenaConfig,
  round: RoundContext,
): Promise<unknown> {
  // 1. Extract structured data using one of the public-web templates.
  const extracted = (await mcp.call('extract_data', {
    tabId: round.tabId,
    schema: round.template.targetSchema.definition,
    waitForReady: true,
  })) as Record<string, unknown> | undefined;
  const observed =
    (extracted?.data as Record<string, unknown> | undefined) ??
    (extracted?.items as unknown) ??
    extracted;

  // 2. Capture the gate fact alongside the result.
  const gateFact = (await mcp.call('oc_gate_inspect', { tabId: round.tabId })) as
    | { detected: boolean; kind?: string; gateType?: string; provider?: string; pageUrl?: string }
    | undefined;

  // 3. Run schema-diff inside an evidence bundle.
  const bundle = (await mcp.call('oc_evidence_bundle', {
    tab_id: round.tabId,
    include: ['schema_diff'],
    target_schema: round.template.targetSchema.definition,
    evidence: { snapshot: { observed } },
  })) as { schema_diff?: import('./map-to-airena').SchemaDiffShape; meta?: { path_taken?: string } } | undefined;

  // 4. Profile fingerprint (optional).
  let profileFingerprint: { hash: string; breakdown?: Record<string, unknown> } | undefined;
  try {
    const fp = (await mcp.call('oc_profile_fingerprint', { tabId: round.tabId })) as
      | { hash: string; breakdown?: Record<string, unknown> }
      | undefined;
    profileFingerprint = fp;
  } catch {
    profileFingerprint = undefined;
  }

  // 5. Compose the airena envelope via the pure mapper.
  const envelope = mapToAirenaRound({
    targetUrl: round.targetUrl,
    schemaDiff: bundle?.schema_diff,
    gateFact: gateFact?.detected ? gateFact : null,
    profileFingerprint,
    pathTaken: bundle?.meta?.path_taken,
  });

  // 6. POST to airena.
  const response = await fetch(`${airena.apiBaseUrl}/round`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${airena.apiKey}`,
    },
    body: JSON.stringify({ round: airena.round, ...envelope }),
  });
  if (!response.ok) {
    throw new Error(`airena POST failed: ${response.status} ${response.statusText}`);
  }
  return await response.json();
}
