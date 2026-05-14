/**
 * Domain Guard - Blocks or allowlists AI agent navigation targets.
 * Default-allow: no domains are restricted unless explicitly configured.
 */
import net from 'node:net';
import { domainToASCII } from 'node:url';

import { getGlobalConfig } from '../config/global';
import { getMetricsCollector } from '../metrics/collector';
import { extractHostname as extractHostnameFromUrl } from '../utils/url-utils';

export type DomainBlockReason = 'host-not-allowed' | 'scheme-not-allowed' | 'blocked-domain';

export interface DomainBlockedResult {
  blocked: true;
  reason: DomainBlockReason;
  attemptedUrl: string;
  matchedPattern: string | null;
}

export class DomainPolicyError extends Error {
  readonly blocked: DomainBlockedResult;

  constructor(blocked: DomainBlockedResult) {
    super(formatBlockedMessage(blocked));
    this.name = 'DomainPolicyError';
    this.blocked = blocked;
  }
}

export function isInternalBrowserUrl(url: string): boolean {
  return (
    url === 'about:blank' ||
    url.startsWith('about:') ||
    url.startsWith('chrome:') ||
    url.startsWith('chrome-extension:') ||
    url.startsWith('devtools:')
  );
}

function formatBlockedMessage(blocked: DomainBlockedResult): string {
  if (blocked.reason === 'scheme-not-allowed') {
    return `Navigation blocked by host allowlist: unsupported URL scheme for ${blocked.attemptedUrl}`;
  }
  if (blocked.reason === 'host-not-allowed') {
    return `Navigation blocked by host allowlist: host is not allowed for ${blocked.attemptedUrl}`;
  }
  return `Access to domain is blocked by security policy (matched pattern: "${blocked.matchedPattern}"). ` +
    `Configure blocked_domains in your OpenChrome security settings to change this.`;
}

function recordBlocked(reason: DomainBlockReason): void {
  try {
    getMetricsCollector().inc('openchrome_navigation_blocked_total', { reason });
  } catch {
    // Best-effort; policy enforcement must not depend on metrics.
  }
}

function normalizePattern(pattern: string): string {
  const trimmed = pattern.trim().toLowerCase();
  if (!trimmed) return '';
  if (trimmed.startsWith('*.')) {
    const suffix = normalizeHost(trimmed.slice(2));
    return suffix ? `*.${suffix}` : '';
  }
  return normalizeHost(trimmed);
}

function normalizeHost(host: string): string {
  const withoutPort = host.replace(/^\[(.*)\]$/, '$1');
  if (net.isIP(withoutPort)) return withoutPort.toLowerCase();
  const stripped = withoutPort.split(':')[0] ?? withoutPort;
  return domainToASCII(stripped.replace(/\.$/, '').toLowerCase());
}

/**
 * Convert the legacy blocklist glob pattern to a RegExp.
 * Supports "*" as a wildcard matching any sequence of non-dot characters.
 */
function globToRegex(pattern: string): RegExp {
  if (pattern.length > 253) {
    throw new Error(`Domain pattern too long (${pattern.length} chars, max 253): "${pattern.slice(0, 50)}..."`);
  }
  const escaped = normalizePattern(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regexStr = escaped.replace(/\*/g, '[^.]*');
  return new RegExp(`^${regexStr}$`, 'i');
}

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    try {
      return new URL(`https://${url}`);
    } catch {
      return null;
    }
  }
}

/**
 * Extract the hostname from a URL string.
 * Returns null for invalid URLs or special schemes (about:, chrome:, etc.).
 */
function extractHostname(url: string): string | null {
  if (
    isInternalBrowserUrl(url)
  ) {
    return null;
  }

  if (url.startsWith('data:')) {
    return null;
  }

  const hostname = normalizeHost(extractHostnameFromUrl(url));
  if (hostname) return hostname;

  const fallback = normalizeHost(extractHostnameFromUrl('https://' + url));
  return fallback || null;
}

function matchesAllowPattern(hostname: string, rawPattern: string): boolean {
  const pattern = normalizePattern(rawPattern);
  if (!pattern) return false;
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(2);
    return hostname.endsWith(`.${suffix}`) && hostname !== suffix;
  }
  return hostname === pattern;
}

function getAllowHosts(): string[] {
  const configured = getGlobalConfig().security?.allow_hosts ?? [];
  const env = process.env.OPENCHROME_ALLOW_HOSTS;
  if (!env) return configured;
  return [
    ...configured,
    ...env.split(',').map((part) => part.trim()).filter(Boolean),
  ];
}

function allowlistViolation(url: string): DomainBlockedResult | null {
  const allowHosts = getAllowHosts();
  if (allowHosts.length === 0) return null;

  const parsed = parseUrl(url);
  if (!parsed || !['http:', 'https:'].includes(parsed.protocol)) {
    return { blocked: true, reason: 'scheme-not-allowed', attemptedUrl: url, matchedPattern: null };
  }
  const hostname = normalizeHost(parsed.hostname);
  const matchedPattern = allowHosts.find((pattern) => matchesAllowPattern(hostname, pattern)) ?? null;
  if (!matchedPattern) {
    return { blocked: true, reason: 'host-not-allowed', attemptedUrl: url, matchedPattern: null };
  }
  return null;
}

/**
 * Check whether a URL's domain is blocked by the configured blocklist.
 * Returns false (allowed) if no blocked_domains are configured.
 */
export function isDomainBlocked(url: string): boolean {
  const config = getGlobalConfig();
  const blockedDomains = config.security?.blocked_domains;

  if (!blockedDomains || blockedDomains.length === 0) {
    return false;
  }

  const hostname = extractHostname(url);
  if (!hostname) {
    return false;
  }

  return blockedDomains.some((pattern) => globToRegex(pattern).test(hostname));
}

export function getDomainPolicyBlockedResult(url: string): DomainBlockedResult | null {
  const allowViolation = allowlistViolation(url);
  if (allowViolation) return allowViolation;

  const blockedDomains = getGlobalConfig().security?.blocked_domains;
  if (!blockedDomains || blockedDomains.length === 0) return null;

  const hostname = extractHostname(url);
  if (!hostname) return null;

  const matchedPattern = blockedDomains.find((pattern) => globToRegex(pattern).test(hostname)) ?? null;
  if (!matchedPattern) return null;
  return { blocked: true, reason: 'blocked-domain', attemptedUrl: url, matchedPattern };
}

/**
 * Assert that the given URL is allowed by the configured domain policy.
 * Throws a structured DomainPolicyError if blocked.
 */
export function assertDomainAllowed(url: string): void {
  const blocked = getDomainPolicyBlockedResult(url);
  if (!blocked) return;
  recordBlocked(blocked.reason);
  throw new DomainPolicyError(blocked);
}
