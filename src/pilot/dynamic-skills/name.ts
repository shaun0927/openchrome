/**
 * Deterministic synthesized tool naming (issue #889).
 *
 * The synthesized tool name is `skill_<domain-slug>__<skill-slug>` where the
 * separator is a double underscore. Handwritten core tools never use `__`,
 * so the namespace is collision-free.
 *
 * Sanitization rules (applied to both segments):
 *   - lowercased
 *   - any non-alphanumeric run collapses into a single `-`
 *   - leading/trailing `-` stripped
 *   - empty result after sanitization is rejected with a thrown Error so
 *     the caller surfaces a structured failure rather than emitting a
 *     malformed tool name
 *   - segments longer than 64 chars are truncated (defensive cap; real
 *     domains rarely exceed 63 chars per RFC 1035 label and skill names
 *     are operator-supplied short strings)
 *
 * The full synthesized name must match this regex (also asserted in the
 * synthesizer unit tests):
 *
 *   ^skill_[a-z0-9-]+__[a-z0-9-]+$
 */

const SEGMENT_MAX_LEN = 64;

/** Pattern the full synthesized name MUST match. */
export const SYNTHESIZED_TOOL_NAME_PATTERN = /^skill_[a-z0-9-]+__[a-z0-9-]+$/;

/**
 * Slugify a single segment (a domain or a skill name) using the rules
 * documented in the module header. Throws when the input cannot produce
 * a non-empty slug — callers MUST handle that path because emitting a
 * malformed MCP tool name would corrupt the protocol envelope.
 */
export function slugifySegment(input: string): string {
  if (typeof input !== 'string') {
    throw new Error('dynamic-skills/name: segment must be a string');
  }
  const lowered = input.toLowerCase();
  // Replace any run of non-[a-z0-9] with a single dash.
  const dashed = lowered.replace(/[^a-z0-9]+/g, '-');
  // Strip leading / trailing dashes.
  const stripped = dashed.replace(/^-+|-+$/g, '');
  if (stripped.length === 0) {
    throw new Error(
      `dynamic-skills/name: input "${input}" reduced to an empty slug after sanitization`,
    );
  }
  return stripped.length > SEGMENT_MAX_LEN ? stripped.slice(0, SEGMENT_MAX_LEN) : stripped;
}

/**
 * Compose a synthesized tool name from a (domain, skillName) pair. The
 * returned string is guaranteed to satisfy `SYNTHESIZED_TOOL_NAME_PATTERN`.
 */
export function synthesizedToolName(domain: string, skillName: string): string {
  const domainSlug = slugifySegment(domain);
  const skillSlug = slugifySegment(skillName);
  const name = `skill_${domainSlug}__${skillSlug}`;
  // Defensive — should never trigger because both segments are already
  // [a-z0-9-]+ after slugifySegment.
  if (!SYNTHESIZED_TOOL_NAME_PATTERN.test(name)) {
    throw new Error(
      `dynamic-skills/name: composed name "${name}" failed the synthesized-tool pattern`,
    );
  }
  return name;
}

/**
 * Returns true iff `name` is in the synthesized-tool namespace. Callers
 * use this to filter `tools/list` snapshots in tests and to reject
 * handwritten tools that try to claim a `__`-bearing name.
 */
export function isSynthesizedToolName(name: string): boolean {
  return typeof name === 'string' && SYNTHESIZED_TOOL_NAME_PATTERN.test(name);
}
