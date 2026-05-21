import type { Extractor, ExtractorContext, ExtractorResult } from './types';
import type { MCPAdapter } from '../benchmark-runner';

export type LivePayloadSource = 'live' | 'recorded-live';
export interface LiveExtractorFactoryOptions { adapterFactory: () => MCPAdapter; library: string; mode: string; source?: LivePayloadSource; }

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function fieldTextFromMarkupOrSnapshot(payload: string, fieldKey: string): string | null {
  const escapedKey = escapeRegExp(fieldKey);
  const snapshotLine = new RegExp(String.raw`<[^>]*\bdata-field=(?:"${escapedKey}"|'${escapedKey}')[^>]*\/?>\s*([^<\n]*)`, 'i');
  const match = payload.match(snapshotLine);
  const value = match?.[1]?.trim();
  return value ? value : null;
}

function serializedSnapshotFields(payload: string, ctx: ExtractorContext): Record<string, string | null> | null {
  const extracted: Record<string, string | null> = Object.fromEntries(ctx.groundTruth.fields.map((field) => [field.key, null]));
  let found = false;
  for (const field of ctx.groundTruth.fields) {
    const value = fieldTextFromMarkupOrSnapshot(payload, field.key);
    if (value !== null) found = true;
    extracted[field.key] = value;
  }
  return found ? extracted : null;
}

function fieldExtractionFromPayload(payload: string, ctx: ExtractorContext): Record<string, string | null> {
  const extracted: Record<string, string | null> = Object.fromEntries(ctx.groundTruth.fields.map((field) => [field.key, null]));
  const trimmed = payload.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      for (const field of ctx.groundTruth.fields) {
        const value = parsed[field.key];
        extracted[field.key] = typeof value === 'string' ? value : null;
      }
      return extracted;
    } catch {
      // Fall through to HTML parsing. Malformed JSON is not structured evidence.
    }
  }
  const snapshotExtracted = serializedSnapshotFields(payload, ctx);
  if (snapshotExtracted) return snapshotExtracted;
  return snapshotExtracted ?? extracted;
}

export function createLiveMcpExtractor(options: LiveExtractorFactoryOptions): Extractor {
  return {
    library: options.library,
    mode: options.mode,
    liveOnly: true,
    extract(ctx: ExtractorContext): ExtractorResult | null {
      if (!ctx.liveAllowed) return null;
      throw new Error(`${options.library}/${options.mode} requires async live extraction; use extractLiveMcpPayload`);
    },
  };
}

export async function extractLiveMcpPayload(options: LiveExtractorFactoryOptions, url: string, ctx: ExtractorContext): Promise<ExtractorResult> {
  const adapter = options.adapterFactory();
  let tabId: unknown;
  try {
    await adapter.setup?.();
    const create = await adapter.callTool('tabs_create', { url });
    if (create.isError) throw new Error(create.content?.[0]?.text ?? 'tabs_create failed');
    tabId = JSON.parse(create.content?.[0]?.text ?? '{}').tabId;
    const read = await adapter.callTool('read_page', { tabId, mode: options.mode });
    if (read.isError) throw new Error(read.content?.[0]?.text ?? 'read_page failed');
    const payload = read.content?.map((c) => c.text ?? '').join('\n') ?? '';
    return { payload, extracted: fieldExtractionFromPayload(payload, ctx) };
  } finally {
    if (tabId !== undefined) await adapter.callTool('tabs_close', { tabId }).catch(() => undefined);
    await adapter.teardown?.();
  }
}
