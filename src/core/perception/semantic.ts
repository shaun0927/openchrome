/**
 * Semantic Perception View (issue #850)
 *
 * Pure deterministic transformation from AX tree + DOM snapshot into a
 * compact, NL-labeled JSON document of "regions" plus their available
 * actions.
 *
 * P3 compliance: no LLM, no HTTP, no I/O. Rule-based only. The rules
 * live in `semantic-rules.json` (loaded by the caller and passed in as
 * `ruleSet`) so they are version-pinned.
 *
 * P2 compliance: this module is consumed exclusively by mode='semantic'
 * in `src/tools/read-page.ts`. The default (mode='dom') path never
 * touches `buildSemanticView`.
 *
 * P5 compliance: pure JS / TS, no new runtime dependencies.
 */

/* ------------------------------------------------------------------ */
/* Public input types                                                  */
/* ------------------------------------------------------------------ */

/**
 * One AX node, normalized for `buildSemanticView`. The caller is
 * responsible for converting the CDP `AXNode` shape into this view.
 * Keeping the shape decoupled from CDP makes the module unit-testable.
 */
export interface SemanticAXNode {
  /** Stable index, NOT the unstable CDP nodeId. Used only inside semantic.ts. */
  nodeId: number;
  /** Optional CDP backendDOMNodeId — required for action ref generation. */
  backendDOMNodeId?: number;
  role: string;
  name?: string;
  value?: string;
  /** href attribute, when role === 'link'. */
  href?: string;
  childIds: number[];
}

export interface SemanticDomElement {
  /** Aligns with `SemanticAXNode.backendDOMNodeId` when both exist. */
  backendDOMNodeId?: number;
  /** Lowercase tag name (e.g., 'article'). */
  tagName: string;
  /** schema.org itemtype URL when present. */
  itemType?: string;
  /** Microdata itemprop name when present (schema.org/Product fields). */
  itemProp?: string;
  /** Class list as space-separated string for cheap substring checks. */
  classNames?: string;
  /** Selected attributes (data-price, data-product-id, etc.). */
  attrs?: Record<string, string>;
  /** Trimmed inline text content (first 200 chars). */
  text?: string;
  childIds: number[];
}

export interface SemanticDomSnapshot {
  /** All elements keyed by a stable id. Roots have no parent. */
  elements: SemanticDomElement[];
  /** Optional indexes into `elements` for O(1) lookup by backend node id. */
  byBackendNodeId?: Record<number, number>;
}

export interface SemanticRuleSet {
  version: number;
  listCollapseThreshold: number;
  summaryMaxChars: number;
  regionRoles: string[];
  regionTags: string[];
  interactiveRoles: string[];
  verbMapping: Record<string, string>;
  kindClassifiers: Record<string, KindClassifier>;
  labelTemplates: Record<string, string>;
}

export interface KindClassifier {
  anyRole?: string[];
  anyTag?: string[];
  anyMicrodata?: string[];
  anyDomClass?: string[];
  anyDomAttr?: string[];
  minFieldCount?: number;
}

/* ------------------------------------------------------------------ */
/* Public output types                                                 */
/* ------------------------------------------------------------------ */

export type SemanticRegionKind =
  | 'product'
  | 'form'
  | 'navigation'
  | 'article'
  | 'media'
  | 'list'
  | 'generic';

export type SemanticVerb = 'click' | 'fill' | 'select' | 'navigate' | 'submit';

export interface SemanticAction {
  verb: SemanticVerb;
  target: string;
  ref_id: string;
}

export interface SemanticRegion {
  id: string;
  kind: SemanticRegionKind;
  label: string;
  state: Record<string, string>;
  actions: SemanticAction[];
  ref_ids: string[];
}

export interface SemanticRefEntry {
  ref_id: string;
  backendDOMNodeId: number;
  role: string;
  name?: string;
}

export interface SemanticView {
  url: string;
  title: string;
  regions: SemanticRegion[];
  refs: Record<string, SemanticRefEntry>;
  /** Hint flags. `aria.tree_empty` is set when the AX tree had no children. */
  aria?: { tree_empty?: boolean };
}

/* ------------------------------------------------------------------ */
/* Top-level inputs                                                    */
/* ------------------------------------------------------------------ */

export interface BuildSemanticViewInput {
  url: string;
  title: string;
  /** AX tree nodes, with at least one root. */
  axNodes: SemanticAXNode[];
  /** Optional DOM snapshot used for state extraction and DOM-tag detection. */
  domSnapshot?: SemanticDomSnapshot;
  /**
   * Ref allocator. The caller (read-page.ts) supplies a function that
   * generates a stable refId via `RefIdManager.generateRef`. The
   * semantic module never owns refs.
   */
  allocateRef: (node: SemanticAXNode) => string | undefined;
}

/* ------------------------------------------------------------------ */
/* Implementation                                                       */
/* ------------------------------------------------------------------ */

/**
 * Build a SemanticView from an AX tree + optional DOM snapshot.
 *
 * Deterministic: the only non-deterministic input is `allocateRef`,
 * which is expected to produce a monotonically-increasing counter.
 * Region ids inside this function are derived purely from traversal
 * order ("region:1", "region:2", ...).
 */
export function buildSemanticView(
  input: BuildSemanticViewInput,
  ruleSet: SemanticRuleSet
): SemanticView {
  const { url, title, axNodes, domSnapshot, allocateRef } = input;

  // Empty AX tree → empty view with hint flag (per spec scenario 5).
  if (!axNodes || axNodes.length === 0) {
    return { url, title, regions: [], refs: {}, aria: { tree_empty: true } };
  }

  const axByNodeId = new Map<number, SemanticAXNode>();
  const childSet = new Set<number>();
  for (const node of axNodes) {
    axByNodeId.set(node.nodeId, node);
    for (const c of node.childIds) childSet.add(c);
  }

  // DOM lookup helper. Falls back to undefined when domSnapshot is absent.
  const domByBackendId = new Map<number, SemanticDomElement>();
  if (domSnapshot) {
    if (domSnapshot.byBackendNodeId) {
      for (const [k, idx] of Object.entries(domSnapshot.byBackendNodeId)) {
        const el = domSnapshot.elements[idx];
        if (el) domByBackendId.set(Number(k), el);
      }
    } else {
      for (const el of domSnapshot.elements) {
        if (el.backendDOMNodeId !== undefined) {
          domByBackendId.set(el.backendDOMNodeId, el);
        }
      }
    }
  }

  function domFor(node: SemanticAXNode): SemanticDomElement | undefined {
    if (node.backendDOMNodeId === undefined) return undefined;
    return domByBackendId.get(node.backendDOMNodeId);
  }

  // Region candidate detection. We DFS the AX tree from each root and
  // mark nodes that match either a region role OR a region tag.
  const roots = axNodes.filter((n) => !childSet.has(n.nodeId));
  const regionRoles = new Set(ruleSet.regionRoles);
  const regionTags = new Set(ruleSet.regionTags);

  // Collect candidate subtree roots in deterministic DFS order.
  const candidates: number[] = [];
  function dfsCandidates(nodeId: number): void {
    const node = axByNodeId.get(nodeId);
    if (!node) return;
    const dom = domFor(node);
    const isCandidate =
      regionRoles.has(node.role) ||
      (dom !== undefined && regionTags.has(dom.tagName));
    if (isCandidate) candidates.push(nodeId);
    for (const c of node.childIds) dfsCandidates(c);
  }
  for (const r of roots) dfsCandidates(r.nodeId);

  // Map each candidate to the set of its descendant AX node ids
  // (including itself). Used both for nesting rules and AX-count.
  const subtreeOf = new Map<number, Set<number>>();
  function collectSubtree(nodeId: number, into: Set<number>): void {
    if (into.has(nodeId)) return;
    into.add(nodeId);
    const node = axByNodeId.get(nodeId);
    if (!node) return;
    for (const c of node.childIds) collectSubtree(c, into);
  }
  for (const c of candidates) {
    const s = new Set<number>();
    collectSubtree(c, s);
    subtreeOf.set(c, s);
  }

  // Apply the nesting rule. We pick a stable subset of candidates:
  // for each candidate A, if it is strictly contained in another
  // candidate B AND there is no AX descendant of B outside A's
  // subtree (other than B itself), we drop B. Both can be kept; the
  // outer's `state` and `ref_ids` exclude inner subtrees.
  const candidateIds = new Set(candidates);
  const droppedOuter = new Set<number>();
  for (let i = 0; i < candidates.length; i++) {
    const outer = candidates[i];
    const outerSubtree = subtreeOf.get(outer)!;
    // Find all immediate inner candidates contained in outer.
    const innerCandidates = candidates.filter(
      (c) => c !== outer && outerSubtree.has(c)
    );
    if (innerCandidates.length === 0) continue;
    // Union of inner subtrees.
    const unionInner = new Set<number>();
    for (const ic of innerCandidates) {
      const ics = subtreeOf.get(ic)!;
      for (const n of ics) unionInner.add(n);
    }
    // Count outer AX nodes NOT covered by any inner candidate
    // (excluding the outer node itself).
    let outsideCount = 0;
    for (const n of outerSubtree) {
      if (n === outer) continue;
      if (!unionInner.has(n)) {
        outsideCount++;
      }
    }
    if (outsideCount === 0) {
      droppedOuter.add(outer);
    }
  }
  const keptCandidates = candidates.filter((c) => !droppedOuter.has(c));

  // Compute the "exclude inner" set for every kept candidate. When
  // an outer is kept alongside its inners, its state/refs must skip
  // the inner subtrees.
  const excludeForOuter = new Map<number, Set<number>>();
  for (const c of keptCandidates) {
    const sub = subtreeOf.get(c)!;
    const excl = new Set<number>();
    for (const c2 of keptCandidates) {
      if (c2 === c) continue;
      if (sub.has(c2)) {
        const innerSub = subtreeOf.get(c2)!;
        for (const n of innerSub) excl.add(n);
      }
    }
    excludeForOuter.set(c, excl);
  }

  // Build regions (pre-list-collapse).
  type DraftRegion = {
    rootNodeId: number;
    kind: SemanticRegionKind;
    /** Stable digest of sorted child-role multiset for list-collapse. */
    digest: string;
    state: Record<string, string>;
    actions: SemanticAction[];
    refs: SemanticRefEntry[];
    label: string;
  };

  const drafts: DraftRegion[] = [];
  const refs: Record<string, SemanticRefEntry> = {};

  for (const candNodeId of keptCandidates) {
    const node = axByNodeId.get(candNodeId)!;
    const subtree = subtreeOf.get(candNodeId)!;
    const exclude = excludeForOuter.get(candNodeId) ?? new Set<number>();

    const effective: number[] = [];
    for (const n of subtree) {
      if (exclude.has(n) && n !== candNodeId) continue;
      effective.push(n);
    }
    effective.sort((a, b) => a - b); // deterministic order

    const kind = classifyKind(node, effective, axByNodeId, domFor, ruleSet);
    const state = extractState(node, effective, axByNodeId, domFor, ruleSet);
    const { actions, refEntries } = extractActions(
      effective,
      axByNodeId,
      ruleSet,
      allocateRef
    );
    for (const r of refEntries) refs[r.ref_id] = r;

    const digest = computeChildRoleDigest(node, axByNodeId, ruleSet);
    const label = renderLabel(kind, state, ruleSet);
    drafts.push({
      rootNodeId: candNodeId,
      kind,
      digest,
      state,
      actions,
      refs: refEntries,
      label,
    });
  }

  // Drop generic regions with zero actions (per §5f of the spec).
  const filtered = drafts.filter(
    (d) => d.kind !== 'generic' || d.actions.length > 0
  );

  // Apply the list-collapse rule: ≥ threshold sibling regions sharing
  // the same kind + same role-digest collapse into one 'list' region.
  const collapsed = applyListCollapse(filtered, axByNodeId, ruleSet);

  // Assign deterministic region ids.
  const regions: SemanticRegion[] = collapsed.map((d, idx) => ({
    id: `region:${idx + 1}`,
    kind: d.kind,
    label: d.label,
    state: d.state,
    actions: d.actions,
    ref_ids: d.refs.map((r) => r.ref_id),
  }));

  return { url, title, regions, refs };
}

/* ------------------------------------------------------------------ */
/* Kind classification                                                 */
/* ------------------------------------------------------------------ */

function classifyKind(
  rootNode: SemanticAXNode,
  effectiveNodeIds: number[],
  axByNodeId: Map<number, SemanticAXNode>,
  domFor: (n: SemanticAXNode) => SemanticDomElement | undefined,
  ruleSet: SemanticRuleSet
): SemanticRegionKind {
  const classifiers = ruleSet.kindClassifiers;
  const order: SemanticRegionKind[] = [
    'product',
    'article',
    'navigation',
    'form',
    'media',
    'list',
  ];

  // Gather signals once.
  const rootDom = domFor(rootNode);
  const rootRole = rootNode.role;
  const rootTag = rootDom?.tagName;

  // Pre-compute counts of form fields and microdata for product/article
  // classifiers that need to look inside the subtree.
  let microItemTypes = new Set<string>();
  let formFieldCount = 0;
  let hasPriceSignal = false;
  let hasMediaTag = false;

  if (rootDom?.itemType) microItemTypes.add(rootDom.itemType);

  for (const id of effectiveNodeIds) {
    const n = axByNodeId.get(id);
    if (!n) continue;
    if (
      n.role === 'textbox' ||
      n.role === 'combobox' ||
      n.role === 'searchbox' ||
      n.role === 'checkbox' ||
      n.role === 'radio'
    ) {
      formFieldCount++;
    }
    const dom = domFor(n);
    if (dom?.itemType) microItemTypes.add(dom.itemType);
    if (dom?.classNames && /(?:^|\s)(?:price|product-price)(?:\s|$)/.test(dom.classNames)) {
      hasPriceSignal = true;
    }
    if (dom?.attrs && (dom.attrs['data-price'] || dom.attrs['data-product-id'])) {
      hasPriceSignal = true;
    }
    if (dom?.tagName === 'video' || dom?.tagName === 'audio' || dom?.tagName === 'figure') {
      hasMediaTag = true;
    }
  }

  for (const kind of order) {
    const c = classifiers[kind];
    if (!c) continue;

    if (c.anyMicrodata && c.anyMicrodata.some((t) => microItemTypes.has(t))) {
      if (kind === 'form' && formFieldCount < (c.minFieldCount ?? 0)) continue;
      return kind;
    }

    const roleMatch = c.anyRole?.includes(rootRole) ?? false;
    const tagMatch = rootTag !== undefined && (c.anyTag?.includes(rootTag) ?? false);

    if (kind === 'product') {
      if (hasPriceSignal) return 'product';
      continue;
    }

    if (kind === 'media' && hasMediaTag) return 'media';

    if (kind === 'form') {
      if ((roleMatch || tagMatch) && formFieldCount >= (c.minFieldCount ?? 0)) {
        return 'form';
      }
      continue;
    }

    if (roleMatch || tagMatch) return kind;
  }

  return 'generic';
}

/* ------------------------------------------------------------------ */
/* State extraction                                                     */
/* ------------------------------------------------------------------ */

function extractState(
  rootNode: SemanticAXNode,
  effectiveNodeIds: number[],
  axByNodeId: Map<number, SemanticAXNode>,
  domFor: (n: SemanticAXNode) => SemanticDomElement | undefined,
  ruleSet: SemanticRuleSet
): Record<string, string> {
  const state: Record<string, string> = {};

  // Structured data-price wins over itemprop="price" text, since the
  // attribute carries the canonical numeric value (e.g., "99.99" vs
  // the localized "$99.99"). Process attrs first.
  for (const id of effectiveNodeIds) {
    const n = axByNodeId.get(id);
    if (!n) continue;
    const dom = domFor(n);
    if (!dom) continue;
    if (dom.attrs?.['data-price'] && state.price === undefined) {
      state.price = dom.attrs['data-price'];
    }
  }
  // Microdata-driven state (schema.org/Product, Article, ...).
  for (const id of effectiveNodeIds) {
    const n = axByNodeId.get(id);
    if (!n) continue;
    const dom = domFor(n);
    if (!dom) continue;
    if (dom.itemProp && dom.text) {
      // First-write-wins keeps determinism stable. Skip overwriting
      // any field that was already populated from a higher-priority
      // structured source.
      if (state[dom.itemProp] === undefined) {
        state[dom.itemProp] = truncate(dom.text, ruleSet.summaryMaxChars);
      }
    }
  }

  // First heading text.
  for (const id of effectiveNodeIds) {
    const n = axByNodeId.get(id);
    if (!n) continue;
    if (
      n.role === 'heading' ||
      n.role === 'banner-title' ||
      (n.role === 'StaticText' && id === rootNode.nodeId)
    ) {
      if (n.name && state.heading === undefined) {
        state.heading = truncate(n.name, ruleSet.summaryMaxChars);
        break;
      }
    }
  }
  if (state.heading === undefined && rootNode.name) {
    state.heading = truncate(rootNode.name, ruleSet.summaryMaxChars);
  }

  // Summary (first visible text aggregated).
  if (state.summary === undefined) {
    const parts: string[] = [];
    for (const id of effectiveNodeIds) {
      const n = axByNodeId.get(id);
      if (!n) continue;
      if (
        (n.role === 'StaticText' || n.role === 'paragraph' || n.role === 'text') &&
        n.name &&
        n.name.length > 0
      ) {
        parts.push(n.name);
      }
      if (parts.join(' ').length > ruleSet.summaryMaxChars) break;
    }
    const joined = parts.join(' ').replace(/\s+/g, ' ').trim();
    if (joined) state.summary = truncate(joined, ruleSet.summaryMaxChars);
  }

  return state;
}

function truncate(s: string, max: number): string {
  const norm = s.replace(/\s+/g, ' ').trim();
  if (norm.length <= max) return norm;
  return norm.slice(0, max);
}

/* ------------------------------------------------------------------ */
/* Action extraction                                                   */
/* ------------------------------------------------------------------ */

function extractActions(
  effectiveNodeIds: number[],
  axByNodeId: Map<number, SemanticAXNode>,
  ruleSet: SemanticRuleSet,
  allocateRef: (node: SemanticAXNode) => string | undefined
): { actions: SemanticAction[]; refEntries: SemanticRefEntry[] } {
  const actions: SemanticAction[] = [];
  const refEntries: SemanticRefEntry[] = [];
  const interactive = new Set(ruleSet.interactiveRoles);

  for (const id of effectiveNodeIds) {
    const n = axByNodeId.get(id);
    if (!n) continue;
    if (!interactive.has(n.role)) continue;
    if (n.backendDOMNodeId === undefined) continue;

    const ref_id = allocateRef(n);
    if (!ref_id) continue;

    const verb = mapVerb(n, ruleSet);
    const targetName = (n.name || n.value || n.role).trim();
    const target = `${truncate(targetName, 80)} ${roleSuffix(n.role)}`.trim();

    actions.push({ verb, target, ref_id });
    refEntries.push({
      ref_id,
      backendDOMNodeId: n.backendDOMNodeId,
      role: n.role,
      name: n.name,
    });
  }

  return { actions, refEntries };
}

function roleSuffix(role: string): string {
  switch (role) {
    case 'button':
      return 'button';
    case 'link':
      return 'link';
    case 'textbox':
    case 'searchbox':
      return 'field';
    case 'combobox':
    case 'listbox':
      return 'dropdown';
    case 'checkbox':
      return 'checkbox';
    case 'radio':
      return 'radio';
    default:
      return role;
  }
}

function mapVerb(node: SemanticAXNode, ruleSet: SemanticRuleSet): SemanticVerb {
  const raw = ruleSet.verbMapping[node.role];
  if (raw === 'navigate-or-click') {
    return node.href && node.href.length > 0 ? 'navigate' : 'click';
  }
  if (raw === 'click' || raw === 'fill' || raw === 'select' || raw === 'navigate' || raw === 'submit') {
    return raw;
  }
  return 'click';
}

/* ------------------------------------------------------------------ */
/* List-collapse                                                       */
/* ------------------------------------------------------------------ */

function computeChildRoleDigest(
  rootNode: SemanticAXNode,
  axByNodeId: Map<number, SemanticAXNode>,
  _ruleSet: SemanticRuleSet
): string {
  const roles: string[] = [];
  for (const c of rootNode.childIds) {
    const cn = axByNodeId.get(c);
    if (cn) roles.push(cn.role);
  }
  roles.sort();
  return roles.join('|');
}

type DraftRegion = {
  rootNodeId: number;
  kind: SemanticRegionKind;
  digest: string;
  state: Record<string, string>;
  actions: SemanticAction[];
  refs: SemanticRefEntry[];
  label: string;
};

function applyListCollapse(
  drafts: DraftRegion[],
  _axByNodeId: Map<number, SemanticAXNode>,
  ruleSet: SemanticRuleSet
): DraftRegion[] {
  const threshold = ruleSet.listCollapseThreshold;
  if (drafts.length < threshold) return drafts;

  // Group consecutive regions by (kind, digest).
  const out: DraftRegion[] = [];
  let i = 0;
  while (i < drafts.length) {
    let j = i + 1;
    while (
      j < drafts.length &&
      drafts[j].kind === drafts[i].kind &&
      drafts[j].digest === drafts[i].digest
    ) {
      j++;
    }
    const runLen = j - i;
    if (runLen >= threshold) {
      const first = drafts[i];
      const collapsed: DraftRegion = {
        rootNodeId: first.rootNodeId,
        kind: 'list',
        digest: first.digest,
        state: {
          item_count: String(runLen),
          sample: first.label,
        },
        // refs/actions point only to the first item (per spec §5d).
        actions: first.actions,
        refs: first.refs,
        label: renderLabel(
          'list',
          { item_count: String(runLen), sample: first.label },
          ruleSet
        ),
      };
      out.push(collapsed);
    } else {
      for (let k = i; k < j; k++) out.push(drafts[k]);
    }
    i = j;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Label rendering                                                     */
/* ------------------------------------------------------------------ */

/**
 * Minimal template engine for `semantic-rules.json` label strings.
 *
 * Syntax:
 *   {key}                — substitute state[key], empty string if missing
 *   {key?, literal {key}} — conditional: only emit if state[key] exists
 *   {key?A,B}            — pick state[A] if present else state[B]
 *
 * Keeping it deterministic and small avoids a dependency on a template
 * library (P5).
 */
function renderLabel(
  kind: SemanticRegionKind,
  state: Record<string, string>,
  ruleSet: SemanticRuleSet
): string {
  const tpl = ruleSet.labelTemplates[kind] ?? ruleSet.labelTemplates.generic ?? '';
  let out = '';
  let i = 0;
  while (i < tpl.length) {
    const ch = tpl[i];
    if (ch !== '{') {
      out += ch;
      i++;
      continue;
    }
    // Find matching closing brace (no nested braces in templates).
    const close = tpl.indexOf('}', i + 1);
    if (close === -1) {
      out += tpl.slice(i);
      break;
    }
    const expr = tpl.slice(i + 1, close);
    out += renderExpr(expr, state);
    i = close + 1;
  }
  // Normalize whitespace.
  return out.replace(/\s+/g, ' ').replace(/\s+([,.])/g, '$1').trim();
}

function renderExpr(expr: string, state: Record<string, string>): string {
  // Conditional: "key?then,else" or "key?then" (else empty).
  const q = expr.indexOf('?');
  if (q !== -1) {
    const key = expr.slice(0, q).trim();
    const rest = expr.slice(q + 1);
    const comma = rest.indexOf(',');
    const thenPart = comma === -1 ? rest : rest.slice(0, comma);
    const elsePart = comma === -1 ? '' : rest.slice(comma + 1);
    if (state[key] !== undefined && state[key].length > 0) {
      return interpolate(thenPart, state);
    }
    return interpolate(elsePart, state);
  }
  // Plain key.
  const v = state[expr.trim()];
  return v ?? '';
}

function interpolate(s: string, state: Record<string, string>): string {
  // Replace nested {key} occurrences in the conditional branch.
  let out = '';
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch !== '{') {
      out += ch;
      i++;
      continue;
    }
    const close = s.indexOf('}', i + 1);
    if (close === -1) {
      out += s.slice(i);
      break;
    }
    const key = s.slice(i + 1, close).trim();
    out += state[key] ?? '';
    i = close + 1;
  }
  return out;
}
