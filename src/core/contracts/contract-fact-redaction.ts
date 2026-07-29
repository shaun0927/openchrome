import { isContractFact } from '../../contracts/contract-facts';
import { redactSecretString } from '../secrets/redactor';
import { redactValue } from '../trace/redactor';

const OPAQUE_CDP_TARGET_ID_RE = /^[0-9a-f]{32}$/i;

/** Redact a JSON-shaped value while preserving valid Chrome target IDs in v1 contract facts. */
export function redactContractFactValue<T>(value: T): T {
  const redacted = redactValue(value);
  restoreContractFactTargetIds(value, redacted);
  return redacted as T;
}

function restoreContractFactTargetIds(source: unknown, redacted: unknown): void {
  if (Array.isArray(source)) {
    if (!Array.isArray(redacted)) return;
    for (let index = 0; index < source.length && index < redacted.length; index += 1) {
      restoreContractFactTargetIds(source[index], redacted[index]);
    }
    return;
  }
  if (!isRecord(source) || !isRecord(redacted)) return;

  if (isContractFact(source) && OPAQUE_CDP_TARGET_ID_RE.test(source.target_id)) {
    redacted.target_id = redactSecretString(source.target_id);
  }

  for (const [key, child] of Object.entries(source)) {
    restoreContractFactTargetIds(child, redacted[key]);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
