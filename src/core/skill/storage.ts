/**
 * Per-domain skill graph storage — JSON-per-domain backend.
 *
 * One JSON file per domain at `<rootDir>/<encodedDomain>.json`. This keeps
 * concurrent activity on different domains fully independent — only writes
 * to the same domain serialise via a per-file `proper-lockfile` lock.
 *
 * This module replaces the SQLite backend from closed PR #738 per the
 * portability-harness contract clause P5 (Native dependency discipline —
 * argon2 only). The persisted record shape (nodes + edges +
 * to_state_distribution) is preserved verbatim from PR #738 v2 so the
 * executor (#703) sees an identical graph model.
 *
 * File layout (schema_version 1):
 *   {
 *     "schema_version": 1,
 *     "nodes": { "<state_hash>": { state_hash, evidence?, thumbnail_path?,
 *                                  last_seen_at, visit_count } },
 *     "edges": [ { from_state, action_kind, action_args_norm,
 *                  to_state_distribution, success_count, fail_count,
 *                  last_failed_at?, last_error? } ]
 *   }
 *
 * Concurrency model:
 *   • Cross-domain writes proceed in parallel — separate files, separate
 *     locks.
 *   • Same-domain writes serialise on the per-file `proper-lockfile` lock.
 *   • Every mutating call follows the pattern
 *     `acquireLock → readFileSafe → mutate → writeFileAtomicSafe → release`
 *     so success/fail counters never race against concurrent same-domain
 *     writers (a Codex finding from the previous iteration).
 *
 * The lock file is `<rootDir>/<encodedDomain>.json.lock`. `acquireLock`
 * from `src/utils/atomic-file.ts` creates an empty `{}` placeholder at the
 * lock path if one is missing so `proper-lockfile` has something to lock.
 * The graph data file itself is kept separate from the lock file so the
 * placeholder JSON is never confused with the graph payload.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { acquireLock, readFileSafe, writeFileAtomicSafe } from '../../utils/atomic-file';
import type {
  EdgeKey,
  PersistedEdge,
  PersistedNode,
  SkillEdge,
  SkillGraphFile,
  SkillGraphInspectSummary,
  SkillNode,
  ToStateDistribution,
} from './types';

const CURRENT_SCHEMA_VERSION = 1 as const;

export interface SkillGraphStorageOptions {
  /** Filesystem root for per-domain JSON files. */
  rootDir?: string;
  /** Required: the domain this storage handle owns. */
  domain: string;
}

export interface RecordEdgeInput {
  from_state: string;
  action_kind: string;
  action_args_norm: string;
  /**
   * Optional observed `to_state`. When provided, the edge's
   * `to_state_distribution` is incremented; when omitted (e.g. the action
   * failed before the page settled) the distribution is left alone.
   */
  to_state?: string;
}

/** Default rootDir resolves to `${HOME}/.openchrome/skills`. */
export function defaultSkillGraphRootDir(): string {
  return path.join(os.homedir(), '.openchrome', 'skills');
}

/**
 * Windows reserved device names that are illegal as basenames even with
 * an extension (`CON.json` is rejected by the Win32 file API). Lower-cased
 * for case-insensitive match. Sourced from Microsoft's Win32 file-naming
 * docs.
 */
const WINDOWS_RESERVED_BASENAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com0',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt0',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
]);

/**
 * Encode a domain into a basename safe on every supported OS:
 *
 *   • `encodeURIComponent` handles characters Windows rejects in
 *     filenames (`:`, `[`, `]`, `*`, `?`, `<`, `>`, `|`, `"`, `/`, `\\`,
 *     whitespace, control chars).
 *   • A leading underscore is added when the encoded basename matches a
 *     Windows reserved device name (`CON.json` is invalid even with an
 *     extension; `_CON.json` is fine). The underscore is stable so the
 *     keying remains deterministic for the same domain.
 *
 * Ordinary URL-hostname characters (`a-z`, `0-9`, `.`, `-`) round-trip
 * unchanged, so `amazon.com` still maps to `amazon.com.json`.
 */
function encodeDomainForFilename(domain: string): string {
  const encoded = encodeURIComponent(domain);
  if (WINDOWS_RESERVED_BASENAMES.has(encoded.toLowerCase())) {
    return `_${encoded}`;
  }
  return encoded;
}

function emptyFile(): SkillGraphFile {
  return { schema_version: CURRENT_SCHEMA_VERSION, nodes: {}, edges: [] };
}

function loadNode(row: PersistedNode): SkillNode {
  return {
    stateHash: row.state_hash,
    evidence: row.evidence,
    thumbnailPath: row.thumbnail_path,
    lastSeenAt: row.last_seen_at,
    visitCount: row.visit_count,
  };
}

function loadEdge(row: PersistedEdge): SkillEdge {
  return {
    fromState: row.from_state,
    actionKind: row.action_kind,
    actionArgsNorm: row.action_args_norm,
    toStateDistribution: row.to_state_distribution ?? [],
    successCount: row.success_count,
    failCount: row.fail_count,
    lastFailedAt: row.last_failed_at,
    lastError: row.last_error,
  };
}

function matchesKey(row: PersistedEdge, key: EdgeKey): boolean {
  return (
    row.from_state === key.fromState &&
    row.action_kind === key.actionKind &&
    row.action_args_norm === key.actionArgsNorm
  );
}

function successRate(e: SkillEdge): number {
  const total = e.successCount + e.failCount;
  if (total === 0) return 0;
  return e.successCount / total;
}

/**
 * Single-domain JSON-backed handle. Multiple instances against the same
 * `domain` and `rootDir` are safe — writes serialise on the per-file
 * `proper-lockfile` lock.
 */
export class SkillGraphStorage {
  private readonly rootDir: string;
  readonly domain: string;
  private readonly filePath: string;
  private readonly lockPath: string;

  constructor(opts: SkillGraphStorageOptions) {
    const domain = opts?.domain;
    if (!domain || domain === '.' || domain === '..') {
      throw new Error(`SkillGraphStorage: invalid domain "${domain}"`);
    }
    this.domain = domain;
    this.rootDir = opts.rootDir ?? defaultSkillGraphRootDir();
    fs.mkdirSync(this.rootDir, { recursive: true });
    const basename = `${encodeDomainForFilename(domain)}.json`;
    this.filePath = path.join(this.rootDir, basename);
    // Keep the lock placeholder separate from the data file so the
    // `{}` content `acquireLock` writes never gets parsed as a real
    // empty graph file. Sibling file with `.lock` suffix.
    this.lockPath = path.join(this.rootDir, `${basename}.lock`);
    this.ensureSeedFileSync();
  }

  /**
   * Ensure the per-domain graph file exists with a fresh `schema_version`
   * payload. If a file already exists with the current schema version we
   * leave it alone — the initial-write path has to be idempotent so two
   * processes opening the same domain concurrently do not blank-overwrite
   * each other's state (Codex finding from the SQLite iteration).
   *
   * The check is synchronous so the constructor can present a complete
   * handle to the caller without forcing an `await`.
   */
  private ensureSeedFileSync(): void {
    if (fs.existsSync(this.filePath)) {
      // Validate the existing file roughly; if it's missing or has the
      // wrong schema version, leave it as-is and let the next mutating
      // call read+rewrite under a lock. We must NOT blow it away here.
      return;
    }
    // Best-effort initial seed. If another process creates the same file
    // between `existsSync` and `writeFileSync` the loser's content is
    // identical (empty graph at schema_version 1) so this is safe to
    // re-attempt without coordination.
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(emptyFile(), null, 2), {
        flag: 'wx',
      });
    } catch (err) {
      // EEXIST is fine — another opener won the race and produced an
      // equivalent file. Re-throw anything else so the caller learns
      // about real I/O failures up front instead of at the first write.
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        throw err;
      }
    }
  }

  /** Returns the schema version this handle reads/writes. */
  getSchemaVersion(): number {
    return CURRENT_SCHEMA_VERSION;
  }

  /** Path to the on-disk JSON file (exposed for tests / inspection). */
  getFilePath(): string {
    return this.filePath;
  }

  /**
   * Read the entire graph payload. Best-effort: a missing or corrupted
   * file resolves to an empty graph. Reads do NOT take the write lock —
   * write callers re-read under the lock anyway, and read-only callers
   * (getNode, topEdges, recentFailures, inspect) tolerate a slightly
   * stale snapshot.
   */
  private async readGraph(): Promise<SkillGraphFile> {
    const res = await readFileSafe<SkillGraphFile>(this.filePath);
    if (!res.success || !res.data) {
      return emptyFile();
    }
    const data = res.data;
    if (
      typeof data !== 'object' ||
      data === null ||
      data.schema_version !== CURRENT_SCHEMA_VERSION ||
      typeof data.nodes !== 'object' ||
      data.nodes === null ||
      !Array.isArray(data.edges)
    ) {
      // Unknown schema or shape — present an empty graph to the caller.
      // A subsequent write will canonicalise the file.
      return emptyFile();
    }
    return data;
  }

  /** Synchronous variant for non-async surfaces (`getNode`, etc.). */
  private readGraphSync(): SkillGraphFile {
    if (!fs.existsSync(this.filePath)) return emptyFile();
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch {
      return emptyFile();
    }
    try {
      const data = JSON.parse(raw) as SkillGraphFile;
      if (
        typeof data !== 'object' ||
        data === null ||
        data.schema_version !== CURRENT_SCHEMA_VERSION ||
        typeof data.nodes !== 'object' ||
        data.nodes === null ||
        !Array.isArray(data.edges)
      ) {
        return emptyFile();
      }
      return data;
    } catch {
      return emptyFile();
    }
  }

  private async writeGraph(payload: SkillGraphFile): Promise<void> {
    await writeFileAtomicSafe(this.filePath, payload);
  }

  /**
   * Acquire the per-domain lock, run `mutator` against a freshly-read
   * graph, write back the result, and release the lock. The lock is
   * always released via `try/finally` so a thrown mutator does not strand
   * the lock file.
   */
  private async withLockedGraph<T>(
    mutator: (graph: SkillGraphFile) => T,
  ): Promise<T> {
    const release = await acquireLock(this.lockPath);
    try {
      const graph = await this.readGraph();
      const result = mutator(graph);
      await this.writeGraph(graph);
      return result;
    } finally {
      await release();
    }
  }

  /**
   * Insert or refresh a node. Increments visit_count on every call. The
   * caller's `seenAt` (or `Date.now()` if omitted) becomes the new
   * `last_seen_at`. When `evidence` / `thumbnailPath` are omitted the
   * prior values are preserved (matching the SQLite COALESCE behaviour).
   */
  async upsertNode(args: {
    stateHash: string;
    evidence?: unknown;
    thumbnailPath?: string;
    seenAt?: number;
  }): Promise<void> {
    const seenAt = args.seenAt ?? Date.now();
    await this.withLockedGraph((graph) => {
      const prior = graph.nodes[args.stateHash];
      const next: PersistedNode = {
        state_hash: args.stateHash,
        evidence: args.evidence !== undefined ? args.evidence : prior?.evidence,
        thumbnail_path:
          args.thumbnailPath !== undefined ? args.thumbnailPath : prior?.thumbnail_path,
        last_seen_at: seenAt,
        visit_count: (prior?.visit_count ?? 0) + 1,
      };
      if (next.evidence === undefined) delete next.evidence;
      if (next.thumbnail_path === undefined) delete next.thumbnail_path;
      graph.nodes[args.stateHash] = next;
    });
  }

  /** Look up a node row. Returns `null` if not found. */
  getNode(stateHash: string): SkillNode | null {
    const graph = this.readGraphSync();
    const row = graph.nodes[stateHash];
    return row ? loadNode(row) : null;
  }

  /** Returns all nodes ordered by visit_count DESC. */
  listNodes(limit = 100): SkillNode[] {
    const graph = this.readGraphSync();
    return Object.values(graph.nodes)
      .map(loadNode)
      .sort((a, b) => b.visitCount - a.visitCount)
      .slice(0, limit);
  }

  /**
   * Ensure both endpoints referenced by an edge exist as nodes. The
   * SQLite backend leaned on `FOREIGN KEY` to reject orphan edges; in
   * JSON we enforce the invariant in application code by creating empty
   * Node stubs (`visit_count = 0`) for any state hash the edge mentions
   * that doesn't already have a node row. Same behaviour as the original
   * "create-if-missing" semantics for the executor.
   */
  private ensureNodeStub(graph: SkillGraphFile, stateHash: string, at: number): void {
    if (!graph.nodes[stateHash]) {
      graph.nodes[stateHash] = {
        state_hash: stateHash,
        last_seen_at: at,
        visit_count: 0,
      };
    }
  }

  /**
   * Record (or upsert) an edge with an optional observed `to_state`. The
   * edge's `success_count` / `fail_count` are NOT touched here — call
   * `recordSuccess` or `recordFailure` to update those. Use this when the
   * caller wants to register that an action was attempted without yet
   * knowing the outcome (the SQLite implementation merged both into
   * `recordOutcome`; this split lets callers stamp observation order
   * without forcing a success/fail decision).
   */
  async recordEdge(input: RecordEdgeInput): Promise<void> {
    const at = Date.now();
    await this.withLockedGraph((graph) => {
      this.ensureNodeStub(graph, input.from_state, at);
      if (input.to_state) {
        this.ensureNodeStub(graph, input.to_state, at);
      }
      const idx = graph.edges.findIndex((row) =>
        matchesKey(row, {
          fromState: input.from_state,
          actionKind: input.action_kind,
          actionArgsNorm: input.action_args_norm,
        }),
      );
      if (idx === -1) {
        const dist: ToStateDistribution = input.to_state
          ? [{ to_state: input.to_state, count: 1 }]
          : [];
        graph.edges.push({
          from_state: input.from_state,
          action_kind: input.action_kind,
          action_args_norm: input.action_args_norm,
          to_state_distribution: dist,
          success_count: 0,
          fail_count: 0,
        });
        return;
      }
      const edge = graph.edges[idx];
      if (input.to_state) {
        edge.to_state_distribution = mergeDistribution(
          edge.to_state_distribution,
          input.to_state,
          1,
        );
      }
    });
  }

  /**
   * Increment `success_count` for an existing or newly-created edge.
   * When the edge does not exist yet it is created with
   * `success_count = 1`. Reads happen inside the same lock window as the
   * write so concurrent same-domain writers never race the counter (a
   * Codex finding from the SQLite iteration).
   */
  async recordSuccess(edgeKey: EdgeKey, observedToState?: string): Promise<void> {
    const at = Date.now();
    await this.withLockedGraph((graph) => {
      this.applyOutcome(graph, edgeKey, {
        success: true,
        observedToState,
        at,
      });
    });
  }

  /**
   * Increment `fail_count` for an existing or newly-created edge, stamp
   * `last_failed_at`, and (optionally) capture the error string for the
   * inspector / replay tooling.
   */
  async recordFailure(edgeKey: EdgeKey, error?: string): Promise<void> {
    const at = Date.now();
    await this.withLockedGraph((graph) => {
      this.applyOutcome(graph, edgeKey, {
        success: false,
        at,
        error,
      });
    });
  }

  /**
   * Shared mutator used by recordSuccess / recordFailure. Locates the
   * edge by composite key, creates it if missing, and updates the
   * counters + distribution + last_failed_at fields.
   */
  private applyOutcome(
    graph: SkillGraphFile,
    edgeKey: EdgeKey,
    args: {
      success: boolean;
      at: number;
      observedToState?: string;
      error?: string;
    },
  ): void {
    this.ensureNodeStub(graph, edgeKey.fromState, args.at);
    if (args.observedToState) {
      this.ensureNodeStub(graph, args.observedToState, args.at);
    }
    let idx = graph.edges.findIndex((row) => matchesKey(row, edgeKey));
    if (idx === -1) {
      graph.edges.push({
        from_state: edgeKey.fromState,
        action_kind: edgeKey.actionKind,
        action_args_norm: edgeKey.actionArgsNorm,
        to_state_distribution: [],
        success_count: 0,
        fail_count: 0,
      });
      idx = graph.edges.length - 1;
    }
    const edge = graph.edges[idx];
    if (args.observedToState) {
      edge.to_state_distribution = mergeDistribution(
        edge.to_state_distribution,
        args.observedToState,
        1,
      );
    }
    if (args.success) {
      edge.success_count += 1;
    } else {
      edge.fail_count += 1;
      edge.last_failed_at = args.at;
      if (args.error !== undefined) {
        edge.last_error = args.error;
      }
    }
  }

  /** Look up a single edge row by composite key. */
  getEdge(edgeKey: EdgeKey): SkillEdge | null {
    const graph = this.readGraphSync();
    const row = graph.edges.find((r) => matchesKey(r, edgeKey));
    return row ? loadEdge(row) : null;
  }

  /**
   * Single-read snapshot of every edge originating at `fromState`.
   * Callers that need to compare or rank multiple edges in one decision
   * must use this in preference to looping `getEdge()` — a per-candidate
   * `getEdge()` performs a fresh file read each call, so a concurrent
   * writer can mutate the graph between iterations and produce a
   * recommendation that does not correspond to any single graph state.
   * Returns an empty array when the file is missing or invalid.
   */
  getEdgesFromStateSync(fromState: string): SkillEdge[] {
    const graph = this.readGraphSync();
    return graph.edges
      .filter((row) => row.from_state === fromState)
      .map(loadEdge);
  }

  /**
   * Top edges leaving `fromState` ordered by historical success rate
   * (success / (success+fail)) DESC, with raw success_count as the
   * tiebreaker. Replaces #738's `edgesFrom`; the ordering contract is
   * identical so the executor's "best next action" selector still works.
   */
  topEdges(fromState: string, limit = 100): SkillEdge[] {
    const graph = this.readGraphSync();
    const edges = graph.edges
      .filter((row) => row.from_state === fromState)
      .map(loadEdge);
    edges.sort((a, b) => {
      const ar = successRate(a);
      const br = successRate(b);
      if (ar !== br) return br - ar;
      return b.successCount - a.successCount;
    });
    return edges.slice(0, limit);
  }

  /**
   * Edges with at least one observed failure, ordered by `lastFailedAt`
   * DESC. Used by the inspector to surface recently-broken flows.
   */
  recentFailures(limit = 10): SkillEdge[] {
    const graph = this.readGraphSync();
    return graph.edges
      .filter((row) => row.last_failed_at !== undefined)
      .map(loadEdge)
      .sort((a, b) => (b.lastFailedAt ?? 0) - (a.lastFailedAt ?? 0))
      .slice(0, limit);
  }

  /**
   * Diagnostic snapshot consumed by `oc skill inspect`. Cheap to
   * compute — single pass over the in-memory graph.
   */
  inspect(): SkillGraphInspectSummary {
    const graph = this.readGraphSync();
    const allEdges = graph.edges.map(loadEdge);
    const topRows = [...allEdges]
      .sort((a, b) => b.successCount + b.failCount - (a.successCount + a.failCount))
      .slice(0, 10);
    const failingRows = allEdges
      .filter((e) => e.lastFailedAt !== undefined)
      .sort((a, b) => (b.lastFailedAt ?? 0) - (a.lastFailedAt ?? 0))
      .slice(0, 10);
    return {
      domain: this.domain,
      nodeCount: Object.keys(graph.nodes).length,
      edgeCount: graph.edges.length,
      topEdgesByVisit: topRows.map((e) => ({
        from: e.fromState,
        actionKind: e.actionKind,
        successCount: e.successCount,
        failCount: e.failCount,
      })),
      recentFailures: failingRows.map((e) => ({
        from: e.fromState,
        actionKind: e.actionKind,
        failCount: e.failCount,
        lastFailedAt: e.lastFailedAt ?? 0,
      })),
    };
  }

  /**
   * Symmetric with #738's `close()` so call-sites that already wrap the
   * SQLite handle in a lifecycle don't need to special-case this
   * backend. No open file handles to release in the JSON layout — this
   * is a no-op kept on the surface for parity.
   */
  close(): void {
    // intentionally empty
  }
}

/**
 * Merge a new (`toState`, `count`) observation into the running
 * distribution. The returned array stays sorted by `count` DESC so
 * inspection callers can read the top entry without re-sorting.
 */
function mergeDistribution(
  dist: ToStateDistribution,
  toState: string,
  delta: number,
): ToStateDistribution {
  const next = dist.map((entry) => ({ ...entry }));
  const idx = next.findIndex((entry) => entry.to_state === toState);
  if (idx >= 0) {
    next[idx].count += delta;
  } else {
    next.push({ to_state: toState, count: delta });
  }
  return next.sort((a, b) => b.count - a.count);
}
