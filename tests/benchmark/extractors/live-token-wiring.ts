import type { Extractor, ExtractorContext, ExtractorResult } from './types';
import type { MCPAdapter } from '../benchmark-runner';

export type LivePayloadSource = 'live' | 'recorded-live';
export interface LiveExtractorFactoryOptions { adapterFactory: () => MCPAdapter; library: string; mode: string; source?: LivePayloadSource; }

function fieldExtractionFromPayload(payload: string, ctx: ExtractorContext): Record<string, string | null> {
  const extracted: Record<string, string | null> = {};
  for (const field of ctx.groundTruth.fields) extracted[field.key] = payload.includes(field.expected) ? field.expected : null;
  return extracted;
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
  try {
    await adapter.setup?.();
    const create = await adapter.callTool('tabs_create', { url });
    if (create.isError) throw new Error(create.content?.[0]?.text ?? 'tabs_create failed');
    const tabId = JSON.parse(create.content?.[0]?.text ?? '{}').tabId;
    const read = await adapter.callTool('read_page', { tabId });
    if (read.isError) throw new Error(read.content?.[0]?.text ?? 'read_page failed');
    const payload = read.content?.map((c) => c.text ?? '').join('\n') ?? '';
    await adapter.callTool('tabs_close', { tabId }).catch(() => undefined);
    return { payload, extracted: fieldExtractionFromPayload(payload, ctx) };
  } finally {
    await adapter.teardown?.();
  }
}
