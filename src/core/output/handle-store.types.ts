/**
 * Shared types for the output handle store.
 * Kept separate so tools/_shared/output-handle.schema.ts can import
 * these without depending on the full store implementation.
 */

/** Opaque handle identifier: "oh_" prefix + 12 uppercase base32 chars. */
export type OutputHandle = `oh_${string}`;

export interface OutputHandleResponse {
  output_handle: OutputHandle;
  mime_type: 'application/json' | 'application/gzip' | 'text/markdown';
  size_bytes: number;
  item_count: number | null;
  preview: string | null;
  expires_at: string;
  fetch_with: 'oc_output_fetch';
}
