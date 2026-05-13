import { JournalEntry, TaskJournal } from './task-journal';

const MAX_FAILURE_GROUPS = 5;
const MAX_MILESTONES = 10;
const MAX_PENDING_STEPS = 10;
const MAX_RECOMMENDATIONS = 5;
const MAX_RECENT_ENTRIES = 1000;

export interface HandoffCheckpointState {
  timestamp?: number;
  taskDescription?: string;
  completedSteps?: string[];
  pendingSteps?: string[];
  currentUrl?: string | null;
  tabStates?: Array<{ tabId: string; url: string; title: string }>;
}

export interface HandoffSummaryOptions {
  since?: number;
  sessionId?: string;
  checkpointId?: string;
  checkpoint?: HandoffCheckpointState | null;
  now?: number;
}

export interface HandoffSummary {
  schemaVersion: 1;
  period: {
    start: string | null;
    end: string;
    since: string | null;
    sourceCheckpointId: string | null;
  };
  currentState: {
    sessionId: string | null;
    currentUrl: string | null;
    tabs: Array<{ tabId: string; url: string; title: string }>;
    tabHealth: { status: 'unavailable'; reason: string };
    unavailable?: string[];
  };
  completedMilestones: Array<{
    ts: string;
    tool: string;
    sessionId: string;
    tabId?: string;
    summary: string;
  }>;
  recentFailures: Array<{
    tool: string;
    sessionId: string;
    tabId?: string;
    count: number;
    firstSeen: string;
    lastSeen: string;
    errorClass: string;
    signature: string;
    sampleSummary: string;
  }>;
  stuckSignals: {
    items: Array<{ ts: string; tool: string; summary: string }>;
    unavailable?: { reason: string };
  };
  pendingSteps: string[];
  recommendedRecoveryOptions: Array<{ reason: string; action: string }>;
  limits: string[];
}

function iso(ts: number | undefined): string | null {
  return typeof ts === 'number' && Number.isFinite(ts) ? new Date(ts).toISOString() : null;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function signatureFor(entry: JournalEntry): string {
  return `${entry.tool}:${stableStringify(entry.args)}`;
}

function entryMatchesSession(entry: JournalEntry, sessionId: string): boolean {
  return entry.sessionId === sessionId || entry.args.sessionId === sessionId;
}

function displaySessionId(entry: JournalEntry): string {
  return typeof entry.args.sessionId === 'string' ? entry.args.sessionId : entry.sessionId;
}

function filterEntries(entries: JournalEntry[], opts: HandoffSummaryOptions): JournalEntry[] {
  return entries.filter(entry => {
    if (opts.sessionId && !entryMatchesSession(entry, opts.sessionId)) return false;
    if (opts.since && entry.ts < opts.since) return false;
    if (opts.checkpoint?.timestamp && entry.ts < opts.checkpoint.timestamp) return false;
    return true;
  });
}

function latestSessionId(entries: JournalEntry[], requested?: string): string | null {
  if (requested) return requested;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const id = displaySessionId(entries[i]);
    if (id) return id;
  }
  return null;
}

function buildFailureGroups(entries: JournalEntry[]): HandoffSummary['recentFailures'] {
  const groups = new Map<string, JournalEntry[]>();
  for (const entry of entries.filter(e => !e.ok)) {
    const key = `${entry.sessionId}:${entry.tabId ?? 'none'}:${signatureFor(entry)}`;
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }

  return Array.from(groups.values())
    .sort((a, b) => b[b.length - 1].ts - a[a.length - 1].ts)
    .slice(0, MAX_FAILURE_GROUPS)
    .map(group => {
      const first = group[0];
      const last = group[group.length - 1];
      return {
        tool: first.tool,
        sessionId: displaySessionId(first),
        tabId: first.tabId,
        count: group.length,
        firstSeen: iso(first.ts)!,
        lastSeen: iso(last.ts)!,
        errorClass: 'unavailable:journals_store_success_flag_only',
        signature: signatureFor(first).slice(0, 240),
        sampleSummary: first.summary,
      };
    });
}

function buildRecommendations(summary: Pick<HandoffSummary, 'recentFailures' | 'currentState' | 'pendingSteps'>): HandoffSummary['recommendedRecoveryOptions'] {
  const recs: HandoffSummary['recommendedRecoveryOptions'] = [];
  const failedTools = new Set(summary.recentFailures.map(f => f.tool));

  if (failedTools.has('find') || failedTools.has('query_dom') || failedTools.has('read_page')) {
    recs.push({ reason: 'Recent page-observation failures were recorded.', action: 'Refresh the DOM snapshot and retry with a broader selector or text query.' });
  }
  if (failedTools.has('interact') || failedTools.has('fill_form')) {
    recs.push({ reason: 'Recent interaction failures were recorded.', action: 'Re-read the page and choose a currently visible, stable target before retrying.' });
  }
  if (summary.currentState.currentUrl) {
    recs.push({ reason: 'Checkpoint includes a current URL.', action: 'Resume from the latest tab evidence before repeating earlier completed steps.' });
  }
  if (summary.pendingSteps.length > 0) {
    recs.push({ reason: 'Checkpoint includes pending steps.', action: 'Continue with the first pending step after validating the page is still on the expected URL.' });
  }
  if (recs.length === 0) {
    recs.push({ reason: 'No specific failure pattern is available.', action: 'Load the checkpoint or call oc_journal recent before retrying expensive work.' });
  }

  return recs.slice(0, MAX_RECOMMENDATIONS);
}

export function buildHandoffSummary(journal: TaskJournal, opts: HandoffSummaryOptions = {}): HandoffSummary {
  const now = opts.now ?? Date.now();
  const allEntries = journal.getRecent(MAX_RECENT_ENTRIES);
  const entries = filterEntries(allEntries, opts);
  const checkpoint = opts.checkpoint ?? null;
  const startTs = entries[0]?.ts ?? checkpoint?.timestamp ?? opts.since;
  const endTs = entries[entries.length - 1]?.ts ?? now;
  const journalMilestones = entries
    .filter(entry => entry.milestone)
    .map(entry => ({
      ts: iso(entry.ts)!,
      tool: entry.tool,
      sessionId: displaySessionId(entry),
      tabId: entry.tabId,
      summary: entry.summary,
    }));
  const checkpointMilestones = (checkpoint?.completedSteps ?? []).map(step => ({
    ts: iso(checkpoint?.timestamp ?? now)!,
    tool: 'oc_checkpoint',
    sessionId: opts.sessionId ?? latestSessionId(entries) ?? 'unknown',
    summary: `✓ ${step}`,
  }));
  const completedMilestones = [...journalMilestones, ...checkpointMilestones].slice(-MAX_MILESTONES);
  const pendingSteps = (checkpoint?.pendingSteps ?? []).slice(0, MAX_PENDING_STEPS);
  const currentState: HandoffSummary['currentState'] = {
    sessionId: latestSessionId(entries, opts.sessionId),
    currentUrl: checkpoint?.currentUrl ?? checkpoint?.tabStates?.[0]?.url ?? null,
    tabs: (checkpoint?.tabStates ?? []).slice(0, 20),
    tabHealth: { status: 'unavailable', reason: 'checkpoint artifacts do not persist live tab health' },
  };
  const unavailable: string[] = [];
  if (!checkpoint) unavailable.push('checkpoint_state');
  if (!currentState.currentUrl && currentState.tabs.length === 0) unavailable.push('tab_state');
  if (unavailable.length > 0) currentState.unavailable = unavailable;

  const partial = {
    recentFailures: buildFailureGroups(entries),
    currentState,
    pendingSteps,
  };

  const limits = [
    `journal entries scanned: ${Math.min(allEntries.length, MAX_RECENT_ENTRIES)} / ${MAX_RECENT_ENTRIES}`,
    `milestones capped at ${MAX_MILESTONES}`,
    `failure groups capped at ${MAX_FAILURE_GROUPS}`,
    'tool arguments are read from sanitized journal entries only',
  ];
  if (opts.checkpointId && opts.checkpointId !== 'current') {
    limits.push('checkpointId is recorded in the response but only the current checkpoint file exists in this OpenChrome version');
  }
  if (entries.length === 0) limits.push('no journal entries matched the requested scope');

  return {
    schemaVersion: 1,
    period: {
      start: iso(startTs),
      end: iso(endTs)!,
      since: iso(opts.since),
      sourceCheckpointId: opts.checkpointId ?? (checkpoint ? 'current' : null),
    },
    currentState,
    completedMilestones,
    recentFailures: partial.recentFailures,
    stuckSignals: {
      items: [],
      unavailable: { reason: 'HintEngine/ProgressTracker stuck signals are not persisted in journal artifacts yet' },
    },
    pendingSteps,
    recommendedRecoveryOptions: buildRecommendations(partial),
    limits,
  };
}
