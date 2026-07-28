/**
 * Bounded deterministic search across tabs in one logical OpenChrome session.
 */

import { MCPServer } from '../mcp-server';
import { getSessionManager } from '../session-manager';
import {
  areBoundaryMarkersEnabled,
  escapeBoundaryContent,
  wrapBoundaryMarker,
} from '../core/perception/boundary-markers';
import { sanitizeContent } from '../security/content-sanitizer';
import { isTimeoutError, OpenChromeTimeoutError } from '../errors/timeout';
import {
  TABS_SEARCH_MAX_RESPONSE_BYTES,
  TABS_SEARCH_MAX_RESULT_BYTES,
} from '../config/defaults';
import { TOOL_ANNOTATIONS } from '../types/tool-annotations';
import type { MCPResult, MCPToolDefinition, ToolContext, ToolHandler } from '../types/mcp';
import { getRemainingBudget, throwIfAborted } from '../types/mcp';
import { withTimeout } from '../utils/with-timeout';

export const TABS_SEARCH_LIMITS = {
  maxQueryChars: 256,
  defaultResults: 5,
  maxResults: 10,
  maxScannedTabs: 20,
  concurrency: 3,
  perTabTimeoutMs: 2_000,
  maxBodyChars: 20_000,
  maxTextNodes: 5_000,
  maxUrlChars: 512,
  maxTitleChars: 256,
  maxOutputIdChars: 512,
  maxMatchedFields: 3,
  maxSnippetBodyChars: 320,
  maxSnippetChars: 1_024,
  maxErrorChars: 160,
  maxResultBytes: TABS_SEARCH_MAX_RESULT_BYTES,
  maxResponseBytes: TABS_SEARCH_MAX_RESPONSE_BYTES,
} as const;

const definition: MCPToolDefinition = {
  name: 'tabs_search',
  description:
    'Search title, URL, and bounded visible body text across tabs in the selected logical session. Uses deterministic lexical ranking without activating or navigating tabs.',
  category: 'tabs',
  annotations: TOOL_ANNOTATIONS.tabs_search,
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        minLength: 1,
        maxLength: TABS_SEARCH_LIMITS.maxQueryChars,
        description: 'REQUIRED Search text. Matching is deterministic and Unicode-aware.',
      },
      workerId: {
        type: 'string',
        minLength: 1,
        description: `Restrict search to one exact worker ID. IDs longer than the ${TABS_SEARCH_LIMITS.maxOutputIdChars}-character output contract fail instead of being truncated.`,
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: TABS_SEARCH_LIMITS.maxResults,
        description: `Maximum results. Default ${TABS_SEARCH_LIMITS.defaultResults}; max ${TABS_SEARCH_LIMITS.maxResults}.`,
      },
      boundaryMarkers: {
        type: 'boolean',
        description: 'Wrap page-origin snippets in <oc:tab> markers. Default true.',
      },
    },
    required: ['query'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      sessionId: { type: 'string', maxLength: TABS_SEARCH_LIMITS.maxOutputIdChars },
      query: { type: 'string', maxLength: TABS_SEARCH_LIMITS.maxQueryChars },
      workerId: { type: 'string', maxLength: TABS_SEARCH_LIMITS.maxOutputIdChars },
      candidateTabCount: { type: 'integer', minimum: 0 },
      searchedTabCount: { type: 'integer', minimum: 0 },
      matchedTabCount: { type: 'integer', minimum: 0 },
      scanTruncated: { type: 'boolean' },
      responseTruncated: { type: 'boolean' },
      omittedResultCount: { type: 'integer', minimum: 0 },
      omittedErrorCount: { type: 'integer', minimum: 0 },
      results: {
        type: 'array',
        maxItems: TABS_SEARCH_LIMITS.maxResults,
        items: {
          type: 'object',
          properties: {
            tabId: { type: 'string', maxLength: TABS_SEARCH_LIMITS.maxOutputIdChars },
            workerId: { type: 'string', maxLength: TABS_SEARCH_LIMITS.maxOutputIdChars },
            url: { type: 'string', maxLength: TABS_SEARCH_LIMITS.maxUrlChars },
            title: { type: 'string', maxLength: TABS_SEARCH_LIMITS.maxTitleChars },
            matchedFields: {
              type: 'array',
              maxItems: TABS_SEARCH_LIMITS.maxMatchedFields,
              items: { type: 'string', enum: ['title', 'url', 'body'] },
            },
            snippet: { type: 'string', maxLength: TABS_SEARCH_LIMITS.maxSnippetChars },
            urlTruncated: { type: 'boolean' },
            titleTruncated: { type: 'boolean' },
            bodyTruncated: { type: 'boolean' },
          },
          required: [
            'tabId',
            'workerId',
            'url',
            'title',
            'matchedFields',
            'urlTruncated',
            'titleTruncated',
            'bodyTruncated',
          ],
        },
      },
      errors: {
        type: 'array',
        maxItems: TABS_SEARCH_LIMITS.maxScannedTabs,
        items: {
          type: 'object',
          properties: {
            tabId: { type: 'string', maxLength: TABS_SEARCH_LIMITS.maxOutputIdChars },
            workerId: { type: 'string', maxLength: TABS_SEARCH_LIMITS.maxOutputIdChars },
            message: { type: 'string', maxLength: TABS_SEARCH_LIMITS.maxErrorChars },
          },
          required: ['tabId', 'workerId', 'message'],
        },
      },
    },
    required: [
      'sessionId',
      'query',
      'candidateTabCount',
      'searchedTabCount',
      'matchedTabCount',
      'scanTruncated',
      'responseTruncated',
      'omittedResultCount',
      'omittedErrorCount',
      'results',
      'errors',
    ],
  },
};

type MatchedField = 'title' | 'url' | 'body';

interface TabCandidate {
  tabId: string;
  workerId: string;
}

interface ExtractedPageText {
  title: string;
  titleTruncated: boolean;
  body: string;
  bodyTruncated: boolean;
}

interface TabDocument {
  tabId: string;
  workerId: string;
  url: string;
  title: string;
  outputTitle: string;
  titleSuspicious: boolean;
  body: string;
  urlTruncated: boolean;
  titleTruncated: boolean;
  bodyTruncated: boolean;
  sanitizationNote?: string;
}

interface TabReadError {
  tabId: string;
  workerId: string;
  message: string;
}

interface TabReadOutcome {
  document?: TabDocument;
  error?: TabReadError;
  timedOut?: boolean;
}

interface RankedTabResult {
  score: number;
  tabId: string;
  workerId: string;
  url: string;
  title: string;
  matchedFields: MatchedField[];
  snippet?: string;
  urlTruncated: boolean;
  titleTruncated: boolean;
  bodyTruncated: boolean;
}

interface TabsSearchStructuredResult {
  sessionId: string;
  query: string;
  workerId?: string;
  candidateTabCount: number;
  searchedTabCount: number;
  matchedTabCount: number;
  scanTruncated: boolean;
  responseTruncated: boolean;
  omittedResultCount: number;
  omittedErrorCount: number;
  results: Omit<RankedTabResult, 'score'>[];
  errors: TabReadError[];
}

interface SearchableDocument extends TabDocument {
  normalized: Record<MatchedField, string>;
  tokens: Record<MatchedField, string[]>;
  weightedLength: number;
}

interface RankedSearchDocument extends SearchableDocument {
  termFrequencies: Record<MatchedField, number[]>;
  weightedTermFrequencies: number[];
}

const SEARCH_FIELDS: MatchedField[] = ['title', 'url', 'body'];
const RANKING_YIELD_COMPARISONS = 2_048;
const RANKING_RESERVE_MS = 25;

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>,
  context?: ToolContext,
): Promise<MCPResult> => {
  try {
    throwIfAborted(context);

    const queryResult = parseQuery(args.query);
    if ('error' in queryResult) return errorResult(queryResult.error);
    const query = queryResult.value;
    if (codePointLength(sessionId) > TABS_SEARCH_LIMITS.maxOutputIdChars) {
      return outputIdentifierLimitError('sessionId');
    }

    const workerResult = parseWorkerId(args.workerId);
    if ('error' in workerResult) return errorResult(workerResult.error);
    const workerId = workerResult.value;
    if (workerId && codePointLength(workerId) > TABS_SEARCH_LIMITS.maxOutputIdChars) {
      return outputIdentifierLimitError('workerId');
    }

    const limitResult = parseLimit(args.limit);
    if ('error' in limitResult) return errorResult(limitResult.error);
    const limit = limitResult.value;

    const sessionManager = getSessionManager();
    await sessionManager.getOrCreateSession(sessionId);
    const workers = sessionManager.getWorkers(sessionId);
    if (workerId && !workers.some((worker) => worker.id === workerId)) {
      return errorResult(`Worker ${workerId} not found in the selected session`);
    }

    const candidates = workers
      .filter((worker) => !workerId || worker.id === workerId)
      .flatMap((worker) => sessionManager
        .getWorkerTargetIds(sessionId, worker.id)
        .map((tabId) => ({ tabId, workerId: worker.id })))
      .sort(compareCandidates);

    const selected = candidates.slice(0, TABS_SEARCH_LIMITS.maxScannedTabs);
    const oversizedCandidate = selected.find((candidate) => (
      codePointLength(candidate.tabId) > TABS_SEARCH_LIMITS.maxOutputIdChars
      || codePointLength(candidate.workerId) > TABS_SEARCH_LIMITS.maxOutputIdChars
    ));
    if (oversizedCandidate) {
      return outputIdentifierLimitError(
        codePointLength(oversizedCandidate.tabId) > TABS_SEARCH_LIMITS.maxOutputIdChars
          ? 'tabId'
          : 'workerId',
      );
    }
    const outcomes: TabReadOutcome[] = [];
    const scanContext = createScanContext(context);
    for (let index = 0; index < selected.length; index += TABS_SEARCH_LIMITS.concurrency) {
      throwIfAborted(context);
      if (scanContext && getRemainingBudget(scanContext) <= 0) break;
      const batch = selected.slice(index, index + TABS_SEARCH_LIMITS.concurrency);
      const batchOutcomes = await Promise.all(batch.map((candidate) => (
        readTab(sessionManager, sessionId, candidate, scanContext)
      )));
      outcomes.push(...batchOutcomes);
      if (batchOutcomes.some((outcome) => outcome.timedOut)) break;
    }

    const documents = outcomes
      .map((outcome) => outcome.document)
      .filter((document): document is TabDocument => document !== undefined);
    const errors = outcomes
      .map((outcome) => outcome.error)
      .filter((error): error is TabReadError => error !== undefined);
    const boundaryMarkers = areBoundaryMarkersEnabled(args);
    const rankedResults = await rankDocuments(documents, query, boundaryMarkers, context);
    const results = rankedResults
      .slice(0, limit)
      .map(({ score: _score, ...result }) => result);

    const structured: TabsSearchStructuredResult = {
      sessionId,
      query,
      ...(workerId ? { workerId } : {}),
      candidateTabCount: candidates.length,
      searchedTabCount: outcomes.length,
      matchedTabCount: rankedResults.length,
      scanTruncated: candidates.length > outcomes.length,
      responseTruncated: false,
      omittedResultCount: 0,
      omittedErrorCount: 0,
      results,
      errors,
    };

    return fitStructuredResultToBudget(structured);
  } catch (error) {
    throwIfAborted(context);
    return errorResult(`Error searching tabs: ${errorMessage(error)}`);
  }
};

async function readTab(
  sessionManager: ReturnType<typeof getSessionManager>,
  sessionId: string,
  candidate: TabCandidate,
  context?: ToolContext,
): Promise<TabReadOutcome> {
  let active = true;
  try {
    throwIfAborted(context);
    if (context && getRemainingBudget(context) <= 0) {
      return failure(candidate, 'Tab read timed out', true);
    }
    return await withTimeout(
      readTabDocument(sessionManager, sessionId, candidate, context, () => active),
      TABS_SEARCH_LIMITS.perTabTimeoutMs,
      `tabs_search:${candidate.tabId}`,
      context,
    );
  } catch (error) {
    throwIfAborted(context);
    return failure(candidate, errorMessage(error), isTimeoutError(error));
  } finally {
    active = false;
  }
}

async function readTabDocument(
  sessionManager: ReturnType<typeof getSessionManager>,
  sessionId: string,
  candidate: TabCandidate,
  context: ToolContext | undefined,
  isActive: () => boolean,
): Promise<TabReadOutcome> {
  const page = await sessionManager.getPage(
    sessionId,
    candidate.tabId,
    candidate.workerId,
    'tabs_search',
  );
  throwIfAborted(context);
  if (!isActive()) return failure(candidate, 'Tab read timed out');
  if (!page) return failure(candidate, 'Tab is closed or unavailable');

  const rawUrl = page.url();
  const extracted = await page.evaluate(
    (maxBodyChars: number, maxTitleChars: number, maxTextNodes: number): ExtractedPageText => {
      const boundCodePoints = (value: string, maxChars: number) => {
        let text = '';
        let count = 0;
        for (const char of value) {
          if (count >= maxChars) return { text, truncated: true };
          text += char;
          count++;
        }
        return { text, truncated: false };
      };
      const title = boundCodePoints(String(document.title || ''), maxTitleChars);
      const root = document.body || document.documentElement;
      const bodyChars: string[] = [];
      const visibilityCache = new WeakMap<Element, boolean>();
      let visitedTextNodes = 0;
      let bodyTruncated = false;
      let pendingSpace = false;

      const isVisible = (element: Element | null): boolean => {
        if (!element) return true;
        const cached = visibilityCache.get(element);
        if (cached !== undefined) return cached;
        const tag = element.tagName.toLowerCase();
        const excluded = ['script', 'style', 'noscript', 'template', 'svg'].includes(tag);
        const parentVisible = element === root ? true : isVisible(element.parentElement);
        const style = excluded || !parentVisible ? null : getComputedStyle(element);
        const visible = !excluded
          && parentVisible
          && !element.hasAttribute('hidden')
          && element.getAttribute('aria-hidden') !== 'true'
          && style?.display !== 'none'
          && style?.visibility !== 'hidden'
          && style?.visibility !== 'collapse'
          && style?.opacity !== '0';
        visibilityCache.set(element, visible);
        return visible;
      };

      if (root) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let node = walker.nextNode();
        while (node) {
          visitedTextNodes++;
          if (visitedTextNodes > maxTextNodes) {
            bodyTruncated = true;
            break;
          }
          if (isVisible(node.parentElement)) {
            const raw = node.nodeValue || '';
            for (const char of raw) {
              if (/\s/u.test(char)) {
                pendingSpace = bodyChars.length > 0;
                continue;
              }
              if (pendingSpace) {
                if (bodyChars.length >= maxBodyChars) {
                  bodyTruncated = true;
                  break;
                }
                bodyChars.push(' ');
                pendingSpace = false;
              }
              if (bodyChars.length >= maxBodyChars) {
                bodyTruncated = true;
                break;
              }
              bodyChars.push(char);
            }
          }
          if (bodyTruncated) break;
          node = walker.nextNode();
        }
      }
      return {
        title: title.text,
        titleTruncated: title.truncated,
        body: bodyChars.join(''),
        bodyTruncated,
      };
    },
    TABS_SEARCH_LIMITS.maxBodyChars,
    TABS_SEARCH_LIMITS.maxTitleChars,
    TABS_SEARCH_LIMITS.maxTextNodes,
  );
  throwIfAborted(context);
  if (!isActive()) return failure(candidate, 'Tab read timed out');

  const sanitizedUrl = sanitizeContent(rawUrl);
  const sanitizedTitle = sanitizeContent(extracted.title);
  const sanitizedBody = sanitizeContent(extracted.body);
  const boundedUrl = boundText(sanitizedUrl.text, TABS_SEARCH_LIMITS.maxUrlChars);
  const boundedTitle = boundText(sanitizedTitle.text, TABS_SEARCH_LIMITS.maxTitleChars);
  const titleSuspicious = sanitizedTitle.suspiciousPatternCount > 0;
  const safeTitle = titleSuspicious
    ? '[Suspicious page title withheld; see bounded snippet]'
    : escapeBoundaryContent(boundedTitle.text, 'tab');
  const outputTitle = boundText(safeTitle, TABS_SEARCH_LIMITS.maxTitleChars);
  const notes = [
    sanitizedUrl.sanitizationNote,
    sanitizedTitle.sanitizationNote,
    sanitizedBody.sanitizationNote,
  ].map((note) => note.trim()).filter(Boolean);

  return {
    document: {
      tabId: candidate.tabId,
      workerId: candidate.workerId,
      url: boundedUrl.text,
      title: boundedTitle.text,
      outputTitle: outputTitle.text,
      titleSuspicious,
      body: sanitizedBody.text,
      urlTruncated: boundedUrl.truncated,
      titleTruncated: extracted.titleTruncated || boundedTitle.truncated || outputTitle.truncated,
      bodyTruncated: extracted.bodyTruncated,
      ...(notes.length > 0 ? { sanitizationNote: Array.from(new Set(notes)).join(' ') } : {}),
    },
  };
}

async function rankDocuments(
  documents: TabDocument[],
  query: string,
  boundaryMarkers: boolean,
  context?: ToolContext,
): Promise<RankedTabResult[]> {
  throwIfAborted(context);
  if (documents.length === 0) return [];

  throwIfSearchExpired(context);
  const normalizedQuery = normalizeSearchText(query);
  const queryTerms = Array.from(new Set(tokenize(query)));
  const searchable = documents.map(toSearchableDocument);
  const rankedDocuments = await precomputeTermFrequencies(searchable, queryTerms, context);
  const averageLength = rankedDocuments.reduce(
    (sum, document) => sum + document.weightedLength,
    0,
  ) / rankedDocuments.length;
  const documentFrequencies = queryTerms.map((_, termIndex) => (
    rankedDocuments.reduce(
      (count, document) => count + (document.weightedTermFrequencies[termIndex] > 0 ? 1 : 0),
      0,
    )
  ));
  const results: RankedTabResult[] = [];

  for (const document of rankedDocuments) {
    throwIfSearchExpired(context);
    const result = rankDocument(
      document,
      normalizedQuery,
      queryTerms,
      documentFrequencies,
      averageLength,
      boundaryMarkers,
      query,
      rankedDocuments.length,
    );
    if (result) results.push(result);
  }

  return results.sort((a, b) => (
      b.score - a.score
      || compareText(a.workerId, b.workerId)
      || compareText(a.tabId, b.tabId)
    ));
}

function rankDocument(
  document: RankedSearchDocument,
  normalizedQuery: string,
  queryTerms: string[],
  documentFrequencies: number[],
  averageLength: number,
  boundaryMarkers: boolean,
  originalQuery: string,
  documentCount: number,
): RankedTabResult | null {
  const matchedFields = SEARCH_FIELDS
    .filter((field) => fieldMatches(document, field, normalizedQuery));
  if (matchedFields.length === 0) return null;

  let score = 0;
  for (let termIndex = 0; termIndex < queryTerms.length; termIndex++) {
    const termFrequency = document.weightedTermFrequencies[termIndex];
    if (termFrequency === 0) continue;
    const documentFrequency = documentFrequencies[termIndex];
    const inverseDocumentFrequency = Math.log(
      1 + (documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5),
    );
    const lengthRatio = document.weightedLength / Math.max(1, averageLength);
    score += inverseDocumentFrequency * (
      (termFrequency * 2.2) / (termFrequency + 1.2 * (0.25 + 0.75 * lengthRatio))
    );
  }

  if (normalizedQuery) {
    if (document.normalized.title.includes(normalizedQuery)) score += 8;
    if (document.normalized.url.includes(normalizedQuery)) score += 4;
    if (document.normalized.body.includes(normalizedQuery)) score += 2;
  }

  const snippetField = matchedFields.includes('body')
    ? 'body'
    : matchedFields.includes('title') ? 'title' : 'url';
  const boundedNote = document.sanitizationNote
    ? boundText(document.sanitizationNote, Math.floor(TABS_SEARCH_LIMITS.maxSnippetBodyChars / 2)).text
    : '';
  const snippetBudget = Math.max(
    1,
    TABS_SEARCH_LIMITS.maxSnippetBodyChars - codePointLength(boundedNote) - (boundedNote ? 1 : 0),
  );
  const snippetSource = snippetField === 'title' && document.titleSuspicious && !boundaryMarkers
    ? document.outputTitle
    : document[snippetField];
  let snippet = makeSnippet(snippetSource, originalQuery, queryTerms, snippetBudget);
  if (boundedNote) snippet = `${snippet} ${boundedNote}`.trim();
  if (boundaryMarkers && snippet) {
    snippet = makeBoundedBoundarySnippet({
      src: document.url,
      tabId: document.tabId,
      workerId: document.workerId,
    }, snippet) ?? '';
  }

  return {
    score,
    tabId: document.tabId,
    workerId: document.workerId,
    url: document.url,
    title: document.outputTitle,
    matchedFields,
    ...(snippet ? { snippet } : {}),
    urlTruncated: document.urlTruncated,
    titleTruncated: document.titleTruncated,
    bodyTruncated: document.bodyTruncated,
  };
}

function toSearchableDocument(document: TabDocument): SearchableDocument {
  const tokens = {
    title: tokenize(document.title),
    url: tokenize(document.url),
    body: tokenize(document.body),
  };
  return {
    ...document,
    normalized: {
      title: normalizeSearchText(document.title),
      url: normalizeSearchText(document.url),
      body: normalizeSearchText(document.body),
    },
    tokens,
    weightedLength: Math.max(1, tokens.title.length * 4 + tokens.url.length * 2 + tokens.body.length),
  };
}

function fieldMatches(
  document: RankedSearchDocument,
  field: MatchedField,
  normalizedQuery: string,
): boolean {
  if (normalizedQuery && document.normalized[field].includes(normalizedQuery)) return true;
  return document.termFrequencies[field].some((count) => count > 0);
}

async function precomputeTermFrequencies(
  documents: SearchableDocument[],
  queryTerms: string[],
  context?: ToolContext,
): Promise<RankedSearchDocument[]> {
  const ranked: RankedSearchDocument[] = [];
  let comparisonsSinceYield = 0;

  for (const document of documents) {
    const termFrequencies: Record<MatchedField, number[]> = {
      title: new Array(queryTerms.length).fill(0),
      url: new Array(queryTerms.length).fill(0),
      body: new Array(queryTerms.length).fill(0),
    };

    for (const field of SEARCH_FIELDS) {
      for (const token of document.tokens[field]) {
        for (let termIndex = 0; termIndex < queryTerms.length; termIndex++) {
          const term = queryTerms[termIndex];
          if (token === term || (token.length > term.length && token.includes(term))) {
            termFrequencies[field][termIndex]++;
          }
          comparisonsSinceYield++;
          if (comparisonsSinceYield >= RANKING_YIELD_COMPARISONS) {
            comparisonsSinceYield = 0;
            await yieldToEventLoop();
            throwIfSearchExpired(context);
          }
        }
      }
      await yieldToEventLoop();
      throwIfSearchExpired(context);
    }

    ranked.push({
      ...document,
      termFrequencies,
      weightedTermFrequencies: queryTerms.map((_, termIndex) => (
        termFrequencies.title[termIndex] * 4
        + termFrequencies.url[termIndex] * 2
        + termFrequencies.body[termIndex]
      )),
    });
  }

  return ranked;
}

function makeSnippet(text: string, query: string, queryTerms: string[], maxChars: number): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  const chars = Array.from(compact);
  if (chars.length <= maxChars) return compact;
  if (maxChars <= 6) return chars.slice(0, maxChars).join('');

  const lower = compact.toLowerCase();
  const queryLower = query.trim().toLowerCase();
  let matchIndex = queryLower ? lower.indexOf(queryLower) : -1;
  if (matchIndex < 0) {
    for (const term of queryTerms) {
      matchIndex = lower.indexOf(term);
      if (matchIndex >= 0) break;
    }
  }
  if (matchIndex < 0) matchIndex = 0;

  const matchCharIndex = Array.from(compact.slice(0, matchIndex)).length;
  let contentBudget = Math.max(1, maxChars - 6);
  let halfWindow = Math.floor(contentBudget / 2);
  let start = Math.max(0, Math.min(matchCharIndex - halfWindow, chars.length - contentBudget));
  let end = Math.min(chars.length, start + contentBudget);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < chars.length ? '...' : '';
  contentBudget = Math.max(
    1,
    maxChars - codePointLength(prefix) - codePointLength(suffix),
  );
  halfWindow = Math.floor(contentBudget / 2);
  start = Math.max(0, Math.min(matchCharIndex - halfWindow, chars.length - contentBudget));
  end = Math.min(chars.length, start + contentBudget);
  return `${prefix}${chars.slice(start, end).join('')}${suffix}`;
}

function makeBoundedBoundarySnippet(
  attrs: Record<string, string | undefined>,
  body: string,
): string | undefined {
  const emptyWrapper = wrapBoundaryMarker('tab', attrs, '');
  const wrapperChars = codePointLength(emptyWrapper);
  if (wrapperChars >= TABS_SEARCH_LIMITS.maxSnippetChars) return undefined;

  let bodyBudget = Math.min(
    codePointLength(body),
    TABS_SEARCH_LIMITS.maxSnippetChars - wrapperChars,
  );
  while (bodyBudget > 0) {
    const boundedBody = boundText(body, bodyBudget).text;
    const wrapped = wrapBoundaryMarker('tab', attrs, boundedBody);
    const overflow = codePointLength(wrapped) - TABS_SEARCH_LIMITS.maxSnippetChars;
    if (overflow <= 0) return wrapped;
    bodyBudget = Math.max(0, bodyBudget - overflow);
  }
  return undefined;
}

function tokenize(text: string): string[] {
  return normalizeSearchText(text).match(/[\p{L}\p{N}]+/gu) ?? [];
}

function normalizeSearchText(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function compareCandidates(a: TabCandidate, b: TabCandidate): number {
  return compareText(a.workerId, b.workerId) || compareText(a.tabId, b.tabId);
}

function compareText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function parseQuery(value: unknown): { value: string } | { error: string } {
  if (typeof value !== 'string') return { error: 'Error: query is required' };
  const query = value.trim();
  if (!query) return { error: 'Error: query must not be empty' };
  if (codePointLength(query) > TABS_SEARCH_LIMITS.maxQueryChars) {
    return { error: `Error: query exceeds ${TABS_SEARCH_LIMITS.maxQueryChars} characters` };
  }
  return { value: query };
}

function parseWorkerId(value: unknown): { value?: string } | { error: string } {
  if (value === undefined) return { value: undefined };
  if (typeof value !== 'string' || !value.trim()) {
    return { error: 'Error: workerId must be a non-empty string' };
  }
  return { value };
}

function parseLimit(value: unknown): { value: number } | { error: string } {
  if (value === undefined) return { value: TABS_SEARCH_LIMITS.defaultResults };
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > TABS_SEARCH_LIMITS.maxResults) {
    return { error: `Error: limit must be an integer from 1 to ${TABS_SEARCH_LIMITS.maxResults}` };
  }
  return { value: value as number };
}

function boundText(value: string, maxChars: number): { text: string; truncated: boolean } {
  const chars = Array.from(value);
  return chars.length > maxChars
    ? { text: chars.slice(0, maxChars).join(''), truncated: true }
    : { text: value, truncated: false };
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function mcpResultByteLength(result: MCPResult): number {
  return Buffer.byteLength(JSON.stringify(result), 'utf8');
}

function fitStructuredResultToBudget(
  input: TabsSearchStructuredResult,
): MCPResult {
  const results = input.results.map((result) => ({ ...result }));
  const errors = input.errors.map((error) => ({ ...error }));
  let responseTruncated = false;
  let omittedResultCount = 0;
  let omittedErrorCount = 0;

  const build = (): MCPResult => {
    const structured: TabsSearchStructuredResult = {
      ...input,
      responseTruncated,
      omittedResultCount,
      omittedErrorCount,
      results,
      errors,
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(structured) }],
      structuredContent: structured as unknown as Record<string, unknown>,
    };
  };
  const fits = (result: MCPResult): boolean => (
    mcpResultByteLength(result) <= TABS_SEARCH_LIMITS.maxResultBytes
  );

  let candidate = build();
  if (fits(candidate)) return candidate;
  responseTruncated = true;

  for (let index = results.length - 1; index >= 0; index--) {
    if (results[index].snippet === undefined) continue;
    delete results[index].snippet;
    candidate = build();
    if (fits(candidate)) return candidate;
  }

  while (errors.length > 0) {
    errors.pop();
    omittedErrorCount++;
    candidate = build();
    if (fits(candidate)) return candidate;
  }

  while (results.length > 0) {
    results.pop();
    omittedResultCount++;
    candidate = build();
    if (fits(candidate)) return candidate;
  }

  return errorResult(
    `Error: tabs_search metadata exceeds the ${TABS_SEARCH_LIMITS.maxResultBytes}-byte result budget`,
  );
}

function throwIfSearchExpired(context?: ToolContext): void {
  throwIfAborted(context);
  if (context && getRemainingBudget(context) <= 0) {
    throw new OpenChromeTimeoutError('tabs_search ranking', 0, false, true);
  }
}

function createScanContext(context?: ToolContext): ToolContext | undefined {
  if (!context) return undefined;
  const reserveMs = Math.min(
    RANKING_RESERVE_MS,
    Math.max(1, Math.floor(context.deadlineMs / 2)),
  );
  return {
    ...context,
    deadlineMs: Math.max(0, context.deadlineMs - reserveMs),
  };
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function failure(candidate: TabCandidate, message: string, timedOut = false): TabReadOutcome {
  const sanitized = sanitizeContent(message || 'Unknown tab read failure');
  return {
    error: {
      tabId: candidate.tabId,
      workerId: candidate.workerId,
      message: boundText(sanitized.text, TABS_SEARCH_LIMITS.maxErrorChars).text,
    },
    ...(timedOut ? { timedOut: true } : {}),
  };
}

function outputIdentifierLimitError(field: 'sessionId' | 'tabId' | 'workerId'): MCPResult {
  return errorResult(
    `Error: ${field} exceeds the tabs_search output identifier limit of ${TABS_SEARCH_LIMITS.maxOutputIdChars} characters`,
  );
}

function errorMessage(error: unknown): string {
  if (isTimeoutError(error)) return 'Tab read timed out';
  return error instanceof Error ? error.message : String(error);
}

function errorResult(message: string): MCPResult {
  const safeMessage = boundText(sanitizeContent(message).text, TABS_SEARCH_LIMITS.maxErrorChars).text;
  return {
    content: [{ type: 'text', text: safeMessage }],
    isError: true,
  };
}

export function registerTabsSearchTool(server: MCPServer): void {
  server.registerTool('tabs_search', handler, definition);
}
