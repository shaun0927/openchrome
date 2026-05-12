/**
 * Skill-Graph MCP Resource — openchrome://skill-graph/<encodedDomain>
 *
 * Returns a JSON snapshot of the per-domain skill graph at request time.
 * Read-only. Backed by SkillGraphStorage (PR #801).
 *
 * Cache: in-process map keyed by domain, invalidated by mtime check on the
 * underlying JSON file so a fresh read after a write always sees the latest
 * data without hitting the disk on every call when the file is unchanged.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  SkillGraphStorage,
  defaultSkillGraphRootDir,
  type SkillGraphStorageOptions,
} from '../core/skill/storage';
import type { MCPResourceDefinition } from './usage-guide';

/** The URI prefix for all skill-graph resources. */
export const SKILL_GRAPH_RESOURCE_PREFIX = 'openchrome://skill-graph/';

/**
 * Template resource definition registered in the MCP resource list.
 * The actual per-domain URIs are derived at request time from the prefix.
 */
export const skillGraphResourceTemplate: MCPResourceDefinition = {
  uri: SKILL_GRAPH_RESOURCE_PREFIX,
  name: 'skill-graph',
  description:
    'Per-domain skill graph snapshot — nodes, edges, and to_state_distribution as JSON.',
  mimeType: 'text/json',
};

interface CacheEntry {
  mtimeMs: number;
  snapshot: SkillGraphSnapshot;
}

/**
 * The serialised shape returned to MCP callers. Mirrors the on-disk
 * SkillGraphFile layout so consumers can parse nodes + edges directly.
 */
export interface SkillGraphSnapshot {
  domain: string;
  schema_version: number;
  nodes: Record<string, unknown>;
  edges: unknown[];
}

// In-process cache: domain → { mtimeMs, snapshot }
const cache = new Map<string, CacheEntry>();

/** Override root dir for tests. */
let _rootDirOverride: string | undefined;

/** Visible for testing only — override the storage root directory. */
export function _setRootDirOverride(dir: string | undefined): void {
  _rootDirOverride = dir;
  cache.clear();
}

function getRootDir(): string {
  return _rootDirOverride ?? defaultSkillGraphRootDir();
}

/**
 * Resolve the JSON file path for a domain without constructing a full
 * SkillGraphStorage (avoids writing the seed file on a read-only path).
 * We replicate the basename encoding logic from storage.ts:
 *   encodedBasename = encodeURIComponent(domain) [+ leading _ if reserved]
 */
function resolveFilePath(domain: string, rootDir: string): string {
  const encoded = encodeURIComponent(domain);
  const WINDOWS_RESERVED = new Set([
    'con', 'prn', 'aux', 'nul',
    'com0', 'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
    'lpt0', 'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
  ]);
  const basename = WINDOWS_RESERVED.has(encoded.toLowerCase())
    ? `_${encoded}.json`
    : `${encoded}.json`;
  return path.join(rootDir, basename);
}

/**
 * Return a JSON snapshot of the skill graph for `domain`.
 *
 * If the domain has never been seen, returns an empty graph rather than
 * throwing — unknown domains are not an error.
 *
 * Cache invalidation: we stat the file and compare mtimeMs. When the mtime
 * matches the cached entry we return the cached snapshot without re-reading.
 * When the file changes (or does not exist) we re-read from disk.
 */
export function readSkillGraphResource(domain: string): string {
  const rootDir = getRootDir();
  const filePath = resolveFilePath(domain, rootDir);

  // --- mtime-based cache invalidation ---
  let currentMtime = 0;
  try {
    currentMtime = fs.statSync(filePath).mtimeMs;
  } catch {
    // File does not exist — unknown domain, return empty graph.
  }

  const cached = cache.get(domain);
  if (cached && cached.mtimeMs === currentMtime && currentMtime !== 0) {
    return JSON.stringify(cached.snapshot);
  }

  // --- Read (or construct empty) snapshot ---
  let snapshot: SkillGraphSnapshot;

  if (currentMtime === 0) {
    // Domain has no graph file yet.
    snapshot = { domain, schema_version: 1, nodes: {}, edges: [] };
  } else {
    // Use SkillGraphStorage to read so validation / fallback logic is shared.
    const opts: SkillGraphStorageOptions = { domain, rootDir };
    const storage = new SkillGraphStorage(opts);
    try {
      // Read the raw file for the full SkillGraphFile shape so we can
      // include the verbatim nodes + edges in the snapshot.
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw) as {
        schema_version?: number;
        nodes?: Record<string, unknown>;
        edges?: unknown[];
      };
      snapshot = {
        domain,
        schema_version: parsed.schema_version ?? 1,
        nodes: parsed.nodes ?? {},
        edges: parsed.edges ?? [],
      };
    } catch {
      // Corrupted file — degrade gracefully to empty graph.
      snapshot = { domain, schema_version: 1, nodes: {}, edges: [] };
    } finally {
      storage.close();
    }
  }

  // Update cache with the mtime we observed before reading (handles the
  // edge case where the file is written after our stat but before our read
  // — we'll just re-read on the next call, which is correct).
  cache.set(domain, { mtimeMs: currentMtime, snapshot });
  return JSON.stringify(snapshot);
}

/**
 * Extract the domain from a skill-graph resource URI.
 * Returns null if the URI does not match the expected prefix.
 */
export function parseDomainFromUri(uri: string): string | null {
  if (!uri.startsWith(SKILL_GRAPH_RESOURCE_PREFIX)) {
    return null;
  }
  const encoded = uri.slice(SKILL_GRAPH_RESOURCE_PREFIX.length);
  if (!encoded) {
    return null;
  }
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}
