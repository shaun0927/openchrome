/**
 * Format a timestamp age as a human-readable string (e.g., "30s ago", "2m ago", "1h ago").
 */
export function formatAge(timestamp: number): string {
  const ageMs = Date.now() - timestamp;
  if (ageMs < 60000) return `${Math.round(ageMs / 1000)}s ago`;
  if (ageMs < 3600000) return `${Math.round(ageMs / 60000)}m ago`;
  return `${Math.round(ageMs / 3600000)}h ago`;
}
