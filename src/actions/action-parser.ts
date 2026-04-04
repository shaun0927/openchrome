/**
 * Action Parser - Converts natural language instructions into structured action sequences.
 * Uses pattern matching and keyword extraction only — no LLM calls.
 */

export type ActionVerb = 'click' | 'type' | 'select' | 'check' | 'uncheck' | 'hover' | 'scroll' | 'wait' | 'navigate';

export interface ParsedAction {
  action: ActionVerb;
  target?: string;
  value?: string;
  condition?: string;
}

export interface ParseResult {
  success: boolean;
  actions: ParsedAction[];
  error?: string;
  suggestion?: string;
}

// ---------------------------------------------------------------------------
// Verb detection patterns
// ---------------------------------------------------------------------------

/** Returns the ActionVerb for a given phrase prefix, or null if unrecognised. */
function detectVerb(phrase: string): ActionVerb | null {
  const s = phrase.trim().toLowerCase();

  // Korean — check first so multi-byte sequences don't interfere with ASCII patterns
  if (/체크\s*해제|언체크/.test(s)) return 'uncheck';
  if (/체크/.test(s)) return 'check';
  if (/클릭|누르|탭/.test(s)) return 'click';
  if (/입력|작성|쓰|타이핑/.test(s)) return 'type';
  if (/선택|고르/.test(s)) return 'select';
  if (/호버|마우스\s*오버/.test(s)) return 'hover';
  if (/스크롤/.test(s)) return 'scroll';
  if (/기다리|대기/.test(s)) return 'wait';
  if (/이동|열|방문|접속/.test(s)) return 'navigate';

  // English — longer phrases before shorter ones to avoid partial matches
  if (/^(?:hover\s+over|mouse\s+over|hover)\b/.test(s)) return 'hover';
  if (/^(?:scroll\s+(?:down|up|to)|scroll)\b/.test(s)) return 'scroll';
  if (/^(?:wait\s+for|wait)\b/.test(s)) return 'wait';
  if (/^(?:navigate\s+to|go\s+to|open|visit)\b/.test(s)) return 'navigate';
  if (/^(?:fill\s+in|type|enter|input|write)\b/.test(s)) return 'type';
  if (/^(?:select|choose|pick)\b/.test(s)) return 'select';
  if (/^(?:uncheck|untick)\b/.test(s)) return 'uncheck';
  if (/^(?:check|tick)\b/.test(s)) return 'check';
  if (/^(?:click|press|tap)\b/.test(s)) return 'click';

  return null;
}

/** True if the trimmed phrase starts with a recognised verb (English or Korean). */
function startsWithVerb(phrase: string): boolean {
  return detectVerb(phrase) !== null;
}

// ---------------------------------------------------------------------------
// Compound instruction splitter
// ---------------------------------------------------------------------------

/**
 * Split a compound instruction into individual clauses.
 * Splitting happens on:
 *   ", then "  /  ", and then "
 *   " then "   — only when followed by a verb
 *   " and "    — only when followed by a verb (avoids "name and email")
 *   ","        — followed by a space and a verb
 */
function splitIntoSegments(instruction: string): string[] {
  // Normalise whitespace
  const text = instruction.trim().replace(/\s+/g, ' ');

  // First pass: split on ", then " and ", and then " unconditionally
  const parts: string[] = [];
  const unconditional = text.split(/,\s*and\s+then\s+|,\s*then\s+/i);

  for (const part of unconditional) {
    // Second pass within each part: Korean conjunctions, then English conjunctions
    const koreanParts = splitOnKoreanConjunctions(part.trim());
    for (const kp of koreanParts) {
      const subParts = splitOnConjunctions(kp.trim());
      parts.push(...subParts);
    }
  }

  return parts.filter(p => p.length > 0);
}

/**
 * Split Korean compound sentences on conjunctive endings:
 * "하고" (and do), "이고" (and), "고" after verb stem.
 * e.g. "이메일을 입력하고 제출 버튼을 클릭해" → ["이메일을 입력하고", "제출 버튼을 클릭해"]
 * We split AFTER the "하고/고" suffix so the first segment retains it for verb detection.
 */
function splitOnKoreanConjunctions(text: string): string[] {
  // Split on "하고 " (connective "and") between two Korean segments
  // Pattern: split at boundary after "하고" followed by a Korean character
  const parts: string[] = [];
  // Match "하고" or "이고" or "ㄱ고" connectives between clauses
  const re = /하고\s+(?=\S)/gu;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    // Include "하고" in the first segment so its verb can still be detected
    parts.push(text.slice(lastIndex, match.index + 2).trim()); // up to and including "하고"
    lastIndex = match.index + match[0].length;
  }

  parts.push(text.slice(lastIndex).trim());
  return parts.filter(p => p.length > 0);
}

function splitOnConjunctions(text: string): string[] {
  // Split on "WORD, VERB" — comma followed by a verb-starting word
  // or " then VERB" / " and VERB"
  const result: string[] = [];
  let remaining = text;

  // Pattern: (", " | " then " | " and ") followed by a verb-starting token
  const pattern = /(?:,\s+|\s+then\s+|\s+and\s+)(?=[a-z\u3131-\uD7A3\u4E00-\u9FFF])/gi;

  let lastIndex = 0;
  let match: RegExpExecArray | null;
  const re = new RegExp(pattern.source, 'gi');

  while ((match = re.exec(remaining)) !== null) {
    const afterSplit = remaining.slice(match.index + match[0].length);
    if (startsWithVerb(afterSplit)) {
      result.push(remaining.slice(lastIndex, match.index).trim());
      lastIndex = match.index + match[0].length;
    }
  }

  result.push(remaining.slice(lastIndex).trim());
  return result.filter(p => p.length > 0);
}

// ---------------------------------------------------------------------------
// Value / target extractors per verb
// ---------------------------------------------------------------------------

/** Detect a URL anywhere in a string. */
function extractUrl(text: string): string | undefined {
  const m = text.match(/https?:\/\/[^\s,"']+/);
  return m ? m[0] : undefined;
}

function parseClickPhrase(phrase: string): ParsedAction {
  const s = phrase.trim();

  // Korean: "{target}을/를 클릭" or "{target} 클릭"
  const krMatch = s.match(/^(.+?)(?:을|를)?\s+클릭|누르|탭/u);
  if (krMatch) {
    return { action: 'click', target: krMatch[1].trim() };
  }

  // English: strip leading verb words
  const stripped = s.replace(/^(?:click|press|tap)\s+(?:on\s+)?(?:the\s+)?/i, '');
  return { action: 'click', target: stripped || undefined };
}

function parseTypePhrase(phrase: string): ParsedAction {
  const s = phrase.trim();

  // Korean: "{target}에 {value}을/를 입력" or "{value}을/를 입력"
  const krInTarget = s.match(/^(.+?)에\s+(.+?)(?:을|를)?\s+입력/u);
  if (krInTarget) {
    return { action: 'type', target: krInTarget[1].trim(), value: krInTarget[2].trim() };
  }
  const krNoTarget = s.match(/^(.+?)(?:을|를)?\s+입력/u);
  if (krNoTarget) {
    return { action: 'type', value: krNoTarget[1].trim() };
  }

  // English patterns:
  // "type {value} in(to) the {target}"
  const inMatch = s.match(/^(?:type|enter|input|fill\s+in|write)\s+(.+?)\s+in(?:to)?\s+(?:the\s+)?(.+)$/i);
  if (inMatch) {
    return { action: 'type', value: inMatch[1].trim(), target: inMatch[2].trim() };
  }

  // "type {value}"
  const simpleMatch = s.match(/^(?:type|enter|input|fill\s+in|write)\s+(.+)$/i);
  if (simpleMatch) {
    return { action: 'type', value: simpleMatch[1].trim() };
  }

  return { action: 'type' };
}

function parseSelectPhrase(phrase: string): ParsedAction {
  const s = phrase.trim();

  // "select {value} from (the) {target}" / "choose {value} in (the) {target}"
  const fromMatch = s.match(/^(?:select|choose|pick)\s+(.+?)\s+(?:from|in)\s+(?:the\s+)?(.+)$/i);
  if (fromMatch) {
    return { action: 'select', value: fromMatch[1].trim(), target: fromMatch[2].trim() };
  }

  // Korean: "{value}을/를 선택" or "{target}에서 {value} 선택"
  const krSelect = s.match(/^(.+?)(?:을|를)?\s+선택/u);
  if (krSelect) {
    return { action: 'select', value: krSelect[1].trim() };
  }

  const stripped = s.replace(/^(?:select|choose|pick)\s+/i, '');
  return { action: 'select', target: stripped || undefined };
}

function parseNavigatePhrase(phrase: string): ParsedAction {
  const s = phrase.trim();

  // Extract URL first
  const url = extractUrl(s);
  if (url) {
    return { action: 'navigate', value: url };
  }

  // Korean: "{url}로 이동" / "{url}에 접속"
  const krNav = s.match(/^(.+?)(?:로|에)\s+(?:이동|접속)/u);
  if (krNav) {
    return { action: 'navigate', value: krNav[1].trim() };
  }

  // English: strip verb prefix
  const stripped = s.replace(/^(?:navigate\s+to|go\s+to|open|visit)\s+/i, '');
  return { action: 'navigate', value: stripped || undefined };
}

function parseScrollPhrase(phrase: string): ParsedAction {
  const s = phrase.trim();

  // "scroll down to {target}" / "scroll up to {target}" / "scroll to {target}"
  const toMatch = s.match(/^(?:스크롤\s+)?scroll\s+(?:down\s+to|up\s+to|to)\s+(?:the\s+)?(.+)$/i);
  if (toMatch) {
    return { action: 'scroll', target: toMatch[1].trim() };
  }

  // "scroll down" / "scroll up"
  const dirMatch = s.match(/^(?:스크롤\s+)?scroll\s+(down|up)$/i);
  if (dirMatch) {
    return { action: 'scroll', value: dirMatch[1].toLowerCase() };
  }

  // Korean bare: "스크롤"
  if (/^스크롤$/.test(s)) {
    return { action: 'scroll' };
  }

  const stripped = s.replace(/^(?:스크롤|scroll)\s+/i, '');
  return { action: 'scroll', target: stripped || undefined };
}

function parseWaitPhrase(phrase: string): ParsedAction {
  const s = phrase.trim();

  // "wait for {target} to {condition}"
  const toCondMatch = s.match(/^(?:wait\s+for|wait)\s+(?:the\s+)?(.+?)\s+to\s+(appear|disappear|load)$/i);
  if (toCondMatch) {
    return { action: 'wait', target: toCondMatch[1].trim(), condition: toCondMatch[2].toLowerCase() };
  }

  // "wait for {target}"
  const forMatch = s.match(/^(?:wait\s+for|wait)\s+(?:the\s+)?(.+)$/i);
  if (forMatch) {
    return { action: 'wait', target: forMatch[1].trim(), condition: 'appear' };
  }

  // Korean: "{target}을/를 기다리" or "기다리"
  const krWait = s.match(/^(.+?)(?:을|를)?\s*(?:기다리|대기)/u);
  if (krWait) {
    return { action: 'wait', target: krWait[1].trim(), condition: 'appear' };
  }

  return { action: 'wait', condition: 'appear' };
}

function parseCheckPhrase(phrase: string, verb: ActionVerb): ParsedAction {
  const s = phrase.trim();
  const stripped = s.replace(/^(?:uncheck|untick|check|tick|체크\s*해제|언체크|체크)\s+(?:the\s+)?/i, '');
  return { action: verb, target: stripped || undefined };
}

function parseHoverPhrase(phrase: string): ParsedAction {
  const s = phrase.trim();
  const stripped = s.replace(/^(?:hover\s+over|mouse\s+over|hover|호버|마우스\s*오버)\s+(?:the\s+)?/i, '');
  return { action: 'hover', target: stripped || undefined };
}

// ---------------------------------------------------------------------------
// Single-phrase parser
// ---------------------------------------------------------------------------

function parsePhrase(phrase: string): ParsedAction | null {
  const trimmed = phrase.trim();
  if (!trimmed) return null;

  const verb = detectVerb(trimmed);
  if (!verb) {
    // Check if it contains a URL — treat as navigate
    const url = extractUrl(trimmed);
    if (url) return { action: 'navigate', value: url };
    return null;
  }

  switch (verb) {
    case 'click':    return parseClickPhrase(trimmed);
    case 'type':     return parseTypePhrase(trimmed);
    case 'select':   return parseSelectPhrase(trimmed);
    case 'navigate': return parseNavigatePhrase(trimmed);
    case 'scroll':   return parseScrollPhrase(trimmed);
    case 'wait':     return parseWaitPhrase(trimmed);
    case 'check':    return parseCheckPhrase(trimmed, 'check');
    case 'uncheck':  return parseCheckPhrase(trimmed, 'uncheck');
    case 'hover':    return parseHoverPhrase(trimmed);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a natural language browser instruction into a structured action sequence.
 * Pure pattern-matching — no LLM calls, no network I/O.
 */
export function parseInstruction(instruction: string): ParseResult {
  if (!instruction || instruction.trim().length === 0) {
    return {
      success: false,
      actions: [],
      error: 'Instruction is empty',
      suggestion: 'Provide a natural language instruction such as "click the login button" or "type hello in the search box".',
    };
  }

  const segments = splitIntoSegments(instruction);
  const actions: ParsedAction[] = [];
  const failed: string[] = [];

  for (const segment of segments) {
    const parsed = parsePhrase(segment);
    if (parsed) {
      actions.push(parsed);
    } else {
      failed.push(segment);
    }
  }

  if (actions.length === 0) {
    return {
      success: false,
      actions: [],
      error: `Could not parse instruction: "${instruction}"`,
      suggestion: 'Try breaking the instruction into individual steps such as "click X", "type Y in Z", or "navigate to URL".',
    };
  }

  if (failed.length > 0) {
    // Partial parse — return what we have but still signal success for the parseable parts
    return {
      success: true,
      actions,
      suggestion: `Could not parse the following segment(s): ${failed.map(f => `"${f}"`).join(', ')}. Try breaking these into individual tool calls.`,
    };
  }

  return { success: true, actions };
}
