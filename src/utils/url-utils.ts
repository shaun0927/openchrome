/**
 * Extract the hostname from a URL string. Returns empty string on failure.
 */
export function extractHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}
