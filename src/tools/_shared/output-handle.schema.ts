/**
 * Output handle response schema — uniform shape returned by all tools
 * when output_mode='handle' or output_mode='auto' spills to handle.
 *
 * Kept in _shared/ so every tool can import it without creating a
 * circular dependency through the tool registry.
 */

export type { OutputHandle, OutputHandleResponse } from '../../core/output/handle-store.types';

/**
 * Validate that a value matches the OutputHandleResponse shape.
 * Returns a descriptive error string on failure, null on success.
 */
export function validateOutputHandleResponse(val: unknown): string | null {
  if (!val || typeof val !== 'object') return 'not an object';
  const v = val as Record<string, unknown>;
  if (typeof v.output_handle !== 'string' || !/^oh_[A-Z2-7]{12}$/.test(v.output_handle)) {
    return `output_handle "${v.output_handle}" does not match pattern oh_[A-Z2-7]{12}`;
  }
  if (!['application/json', 'application/gzip', 'text/markdown'].includes(v.mime_type as string)) {
    return `mime_type "${v.mime_type}" is not allowed`;
  }
  if (typeof v.size_bytes !== 'number' || v.size_bytes < 0) return 'size_bytes must be >= 0';
  if (v.item_count !== null && typeof v.item_count !== 'number') return 'item_count must be number|null';
  if (v.preview !== null && typeof v.preview !== 'string') return 'preview must be string|null';
  if (typeof v.expires_at !== 'string') return 'expires_at must be string';
  if (v.fetch_with !== 'oc_output_fetch') return 'fetch_with must be "oc_output_fetch"';
  return null;
}
