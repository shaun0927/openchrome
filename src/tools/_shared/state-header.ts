/**
 * State Header — unified page-state envelope for tool responses.
 *
 * Prepends a 4-line header to text-mode tool responses so agents can
 * determine which page a snapshot came from without parsing the payload.
 *
 * Opt-out: set OPENCHROME_STATE_HEADER=off (case-insensitive) to restore
 * v1.11.0 byte-identical output.
 */

export interface PageStateHeader {
  url: string;
  title: string;
  mode: 'ax' | 'dom' | 'css' | 'html' | 'inspect' | 'validate';
  capturedAt: number; // Unix ms — server wall-clock at response assembly
  tabId: string;
}

/**
 * Returns true when the state header should be included in responses.
 * Default is enabled; set OPENCHROME_STATE_HEADER=off to disable.
 */
export function isStateHeaderEnabled(): boolean {
  const val = process.env.OPENCHROME_STATE_HEADER;
  return val === undefined || val.toLowerCase() !== 'off';
}

/**
 * Formats the 4-line header text.
 * The returned string ends with a trailing newline so that
 * `formatHeaderText(h) + existingPayload` is clean without extra newlines.
 * Callers that want a blank separator line should append '\n' before the payload.
 */
export function formatHeaderText(h: PageStateHeader): string {
  const capturedAtIso = new Date(h.capturedAt).toISOString();
  // Escape control characters so a crafted title/url cannot split the fixed
  // 4-line header into extra lines and spoof subsequent fields.
  const safeUrl = h.url.replace(/[\r\n]/g, ' ');
  const safeTitle = h.title.replace(/[\r\n]/g, ' ');
  return (
    `- Page URL: ${safeUrl}\n` +
    `- Page Title: ${safeTitle}\n` +
    `- Page Mode: ${h.mode}\n` +
    `- Captured At: ${capturedAtIso}\n`
  );
}

/**
 * Prepends the state header (+ blank line) to a text payload.
 * Returns the payload unchanged when the header is disabled.
 */
export function prependHeaderText(h: PageStateHeader, payload: string): string {
  if (!isStateHeaderEnabled()) return payload;
  return formatHeaderText(h) + '\n' + payload;
}

/**
 * Merges the state header fields into a JSON-mode response object.
 * Returns the object unchanged when the header is disabled.
 */
export function mergeHeaderJson<T extends object>(h: PageStateHeader, obj: T): T & { state: PageStateHeader } | T {
  if (!isStateHeaderEnabled()) return obj;
  return { state: h, ...obj };
}
