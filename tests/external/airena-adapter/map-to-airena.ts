/**
 * map-to-airena — pure function turning openchrome facts into the
 * scoring envelope airena.lol's /api/round endpoint expects.
 *
 * Inputs (from openchrome MCP):
 *   - schemaDiff:   the `schema_diff` field returned by oc_evidence_bundle
 *                   when invoked with a `target_schema` (B1-PR2).
 *   - gateFact:     the JSON output of oc_gate_inspect (B2-PR1/PR2),
 *                   `null` when no gate was observed.
 *   - profileFingerprint: optional output of oc_profile_fingerprint
 *                   (B3-PR2). When present, attached as a non-secret
 *                   identifier so airena can correlate runs that
 *                   reused the same auth session.
 *   - pathTaken:    optional value of `meta.path_taken` (A3-PR2)
 *                   echoed onto the round so airena can break out
 *                   cdp-vs-static-fetch performance.
 *   - targetUrl:    the round's URL, echoed verbatim.
 *
 * Output: a plain JSON object the caller POSTs to airena's REST API.
 * The mapper never touches the network — that's the adapter's job.
 *
 * Per #1359 §P4 (facts before decisions): every input is a fact
 * openchrome already emits. The mapper composes them; it does not
 * derive any new judgment.
 */

export interface SchemaDiffShape {
  matched: string[];
  missing: string[];
  extra: string[];
  typeMismatch: Array<{ field: string; expected: string; got: string }>;
  coverage: number;
}

export interface GateFact {
  detected: boolean;
  kind?: string;
  gateType?: string;
  provider?: string;
  pageUrl?: string;
}

export interface ProfileFingerprintInput {
  hash: string;
  breakdown?: Record<string, unknown>;
}

export interface MapInput {
  targetUrl: string;
  schemaDiff?: SchemaDiffShape;
  gateFact?: GateFact | null;
  profileFingerprint?: ProfileFingerprintInput;
  pathTaken?: string;
}

export interface AirenaRoundFacts {
  path_taken?: string;
  profile_fingerprint?: string;
  gate?: GateFact;
  schema_diff?: SchemaDiffShape;
}

export type AirenaRoundStatus = 'ok' | 'gated' | 'partial' | 'failed';

export interface AirenaRoundEnvelope {
  url: string;
  coverage: number;
  status: AirenaRoundStatus;
  facts: AirenaRoundFacts;
}

/**
 * Compose the airena scoring envelope.
 *
 * Status rules (closed enum, deterministic):
 *   - gateFact?.detected === true      → 'gated'
 *   - schemaDiff missing entirely      → 'failed'
 *   - coverage === 1                   → 'ok'
 *   - 0 < coverage < 1                 → 'partial'
 *   - coverage === 0                   → 'failed'
 */
export function mapToAirenaRound(input: MapInput): AirenaRoundEnvelope {
  if (!input || typeof input !== 'object') {
    throw new Error('mapToAirenaRound: input is required');
  }
  if (typeof input.targetUrl !== 'string' || input.targetUrl.length === 0) {
    throw new Error('mapToAirenaRound: targetUrl is required');
  }

  const facts: AirenaRoundFacts = {};
  if (input.pathTaken) facts.path_taken = input.pathTaken;
  if (input.profileFingerprint && typeof input.profileFingerprint.hash === 'string') {
    facts.profile_fingerprint = input.profileFingerprint.hash;
  }
  if (input.gateFact) facts.gate = input.gateFact;
  if (input.schemaDiff) facts.schema_diff = input.schemaDiff;

  let status: AirenaRoundStatus;
  if (input.gateFact && input.gateFact.detected) {
    status = 'gated';
  } else if (!input.schemaDiff) {
    status = 'failed';
  } else if (input.schemaDiff.coverage >= 1) {
    status = 'ok';
  } else if (input.schemaDiff.coverage > 0) {
    status = 'partial';
  } else {
    status = 'failed';
  }

  const coverage =
    input.schemaDiff && typeof input.schemaDiff.coverage === 'number'
      ? input.schemaDiff.coverage
      : 0;

  return {
    url: input.targetUrl,
    coverage,
    status,
    facts,
  };
}
