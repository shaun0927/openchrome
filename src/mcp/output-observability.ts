import type { MCPResult } from '../types/mcp';

export function estimateOutputTokensFromChars(chars: number): number {
  // Heuristic only; intentionally avoids provider-specific tokenizer deps.
  return Math.max(0, Math.ceil(chars / 4));
}

const CACHE_STATUS_LABELS = new Set(['HIT', 'MISS', 'BYPASS', 'ERROR']);
const CACHE_KEY_VERSION_LABEL_RE = /^v?\d{1,3}$/i;

function normalizeCacheStatusLabel(raw: string): string {
  const normalized = raw.trim().toUpperCase();
  return CACHE_STATUS_LABELS.has(normalized) ? normalized : 'UNKNOWN';
}

function normalizeCacheKeyVersionLabel(raw: unknown): string {
  if (raw === undefined || raw === null || raw === '') return 'unknown';
  const normalized = String(raw).trim();
  if (normalized === '') return 'unknown';
  return CACHE_KEY_VERSION_LABEL_RE.test(normalized) ? normalized : 'other';
}

export function extractCacheStatus(result: MCPResult): { status: string; keyVersion: string } | null {
  const raw = (result as Record<string, unknown>)._cache
    ?? (result as Record<string, unknown>).cache
    ?? (result as Record<string, unknown>).cacheStatus;
  if (typeof raw === 'string') {
    return { status: normalizeCacheStatusLabel(raw), keyVersion: 'unknown' };
  }
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    const status = typeof obj.status === 'string' ? obj.status : typeof obj.cacheStatus === 'string' ? obj.cacheStatus : null;
    if (!status) return null;
    const keyVersion = obj.keyVersion ?? obj.version ?? 'unknown';
    return {
      status: normalizeCacheStatusLabel(status),
      keyVersion: normalizeCacheKeyVersionLabel(keyVersion),
    };
  }
  if (result.structuredContent && typeof result.structuredContent.cacheStatus === 'string') {
    return {
      status: normalizeCacheStatusLabel(result.structuredContent.cacheStatus),
      keyVersion: normalizeCacheKeyVersionLabel(result.structuredContent.cacheKeyVersion),
    };
  }
  return null;
}
