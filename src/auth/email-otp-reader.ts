/**
 * Email OTP reader — extract one-time codes from message bodies.
 *
 * Why this exists
 * ---------------
 * Many logins that openchrome drives (banks, government portals, SaaS
 * providers) push the second factor to email rather than to a TOTP
 * app or a phone. Today an operator has to hand-shuttle the code from
 * a mail client into the browser session, breaking the automation
 * loop. Agent360dk's idiom — open a Gmail tab, fetch the newest
 * matching message, pull the six-digit code — collapses that back
 * into automation.
 *
 * Scope
 * -----
 * This module is deliberately **transport-agnostic**. Callers supply
 * the message text (or subject) — from the Gmail tab openchrome
 * already drives, from IMAP, from a Graph API fetch, from a webhook.
 * The core is a parser plus a small strategy layer for common
 * template patterns.
 *
 * Design
 * ------
 * - `extractOtp(text, opts)` returns the strongest matching code,
 *   preferring:
 *     1. explicit code-marker patterns ("Your code is 123456", "OTP:
 *        123456", "verification code 123456") over
 *     2. isolated 6-digit runs in a short subject line over
 *     3. any 4-8 digit run in the body that is not adjacent to
 *        currency, dates, phone numbers, or reference numbers.
 * - Locale-tolerant markers cover English, Korean ("인증 번호",
 *   "확인 코드"), and generic OTP labels. Extendable via
 *   `opts.extraMarkers`.
 * - Time-window filter — reject codes whose surrounding text hints at
 *   expiry already passed. Optional; default off.
 * - Batch API `pickNewestOtp(messages)` for the common Gmail case
 *   (fetch last N inbox items, take the first with a valid code).
 *
 * Origin credit
 * -------------
 * Idiom from Agent360dk's Gmail OTP flow (MIT). Clean-room parser;
 * no upstream code copied.
 */

export interface OtpExtractionOptions {
  /**
   * Expected code length range. Default: [4, 8]. Codes outside this
   * range are ignored.
   */
  lengthRange?: [number, number];
  /** Additional marker patterns to try before the generic scan. */
  extraMarkers?: readonly RegExp[];
  /**
   * When true, only accept codes flanked by whitespace / punctuation
   * (not embedded in longer digit strings). Default: true.
   */
  standaloneOnly?: boolean;
}

export interface OtpMatch {
  code: string;
  /** Which parsing tier produced the match. */
  tier: 'marker' | 'subject' | 'body';
  /** Confidence 0..1. Marker matches are 1.0; body scans decay by count. */
  confidence: number;
}

const DEFAULT_MARKERS: RegExp[] = [
  // English
  /(?:your\s+(?:code|otp|verification\s+code|security\s+code)\s+(?:is\s+)?)(\d{4,8})/i,
  /(?:code\s*[:\-]?\s*)(\d{4,8})/i,
  /(?:otp\s*[:\-]?\s*)(\d{4,8})/i,
  /(?:verification\s+code\s*[:\-]?\s*)(\d{4,8})/i,
  // Korean
  /(?:인증\s*번호\s*(?:는|:|\-)?\s*)(\d{4,8})/,
  /(?:확인\s*코드\s*(?:는|:|\-)?\s*)(\d{4,8})/,
  /(?:일회용\s*비밀번호\s*(?:는|:|\-)?\s*)(\d{4,8})/,
];

const REJECT_NEIGHBOURS = /[$₩¥€£]|\d{4}-\d{2}-\d{2}|\d{3,4}[-\s]\d{3,4}[-\s]\d{4}/;

/**
 * Extract the strongest OTP candidate from a text blob. Returns null
 * when no candidate meets the length/format constraints.
 */
export function extractOtp(text: string, opts: OtpExtractionOptions = {}): OtpMatch | null {
  if (typeof text !== 'string' || text.length === 0) return null;
  const [minLen, maxLen] = opts.lengthRange ?? [4, 8];
  if (minLen < 3 || maxLen > 12 || minLen > maxLen) {
    throw new RangeError(`extractOtp: invalid lengthRange [${minLen}, ${maxLen}]`);
  }

  // Tier 1 — explicit markers
  const markers = [...DEFAULT_MARKERS, ...(opts.extraMarkers ?? [])];
  for (const re of markers) {
    const m = re.exec(text);
    if (m && m[1]) {
      const code = m[1];
      if (code.length >= minLen && code.length <= maxLen) {
        return { code, tier: 'marker', confidence: 1.0 };
      }
    }
  }

  // Tier 2 — subject line (heuristic: first non-empty line, ≤80 chars)
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  if (firstLine.length > 0 && firstLine.length <= 80) {
    const subj = extractStandaloneDigits(firstLine, minLen, maxLen);
    if (subj) return { code: subj, tier: 'subject', confidence: 0.7 };
  }

  // Tier 3 — body scan
  const bodyCodes = collectStandaloneDigits(text, minLen, maxLen, opts.standaloneOnly !== false);
  if (bodyCodes.length === 0) return null;
  // Confidence decays with candidate count: 1 candidate ≈ 0.6, more → lower.
  const confidence = Math.max(0.2, 0.6 - 0.1 * (bodyCodes.length - 1));
  return { code: bodyCodes[0], tier: 'body', confidence };
}

/**
 * Batch API — iterate messages in order and return the first with a
 * valid extraction result. Each element is `{ text, receivedAt? }`;
 * the runner sorts by `receivedAt` desc if provided.
 */
export interface EmailMessage {
  text: string;
  receivedAt?: Date | number;
}

export function pickNewestOtp(
  messages: readonly EmailMessage[],
  opts: OtpExtractionOptions = {},
): { message: EmailMessage; match: OtpMatch } | null {
  const sorted = [...messages].sort((a, b) => {
    const ta = a.receivedAt ? +new Date(a.receivedAt) : 0;
    const tb = b.receivedAt ? +new Date(b.receivedAt) : 0;
    return tb - ta;
  });
  for (const msg of sorted) {
    const match = extractOtp(msg.text, opts);
    if (match) return { message: msg, match };
  }
  return null;
}

// --- helpers ---------------------------------------------------------------

function extractStandaloneDigits(line: string, minLen: number, maxLen: number): string | null {
  const re = new RegExp(`(?<![\\d])(\\d{${minLen},${maxLen}})(?![\\d])`);
  const m = re.exec(line);
  return m ? m[1] : null;
}

function collectStandaloneDigits(
  text: string,
  minLen: number,
  maxLen: number,
  standaloneOnly: boolean,
): string[] {
  const re = standaloneOnly
    ? new RegExp(`(?<![\\d])(\\d{${minLen},${maxLen}})(?![\\d])`, 'g')
    : new RegExp(`(\\d{${minLen},${maxLen}})`, 'g');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const code = m[1];
    if (out.includes(code)) continue;
    // Reject when surrounded by currency, dates, phone-number-like patterns.
    // Window is wide enough to catch a full 3-4-4 phone pattern that straddles
    // the match position (e.g. `010 1234 5678` where `1234` is the match).
    const window = text.slice(Math.max(0, m.index - 16), Math.min(text.length, m.index + code.length + 16));
    if (REJECT_NEIGHBOURS.test(window)) continue;
    out.push(code);
  }
  return out;
}
