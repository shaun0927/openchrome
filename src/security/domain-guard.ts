/**
 * Domain Guard - Blocks AI agent access to configured domains
 * Default-allow: no domains blocked unless explicitly configured.
 */
import { getGlobalConfig } from '../config/global';

/**
 * Convert a glob pattern to a RegExp.
 * Supports "*" as a wildcard matching any sequence of non-dot characters,
 * and "**" or leading "*." to match across subdomains.
 * Examples:
 *   "*.bank.com"      -> matches "www.bank.com", "login.bank.com"
 *   "mail.google.com" -> exact match only
 */
function globToRegex(pattern: string): RegExp {
  // Reject overly long patterns (DNS max is 253 chars)
  if (pattern.length > 253) {
    throw new Error(`Domain pattern too long (${pattern.length} chars, max 253): "${pattern.slice(0, 50)}..."`);
  }

  // Escape all regex special chars except "*"
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  // Replace "*" with "[^.]*" to match any non-dot characters (single-level wildcard)
  // This means "*.bank.com" matches "www.bank.com" but NOT "a.b.bank.com"
  const regexStr = escaped.replace(/\*/g, '[^.]*');
  return new RegExp(`^${regexStr}$`, 'i');
}

/**
 * Extract the hostname from a URL string.
 * Returns null for invalid URLs or special schemes (about:, chrome:, etc.).
 */
function extractHostname(url: string): string | null {
  // Always allow special browser URLs
  if (
    url === 'about:blank' ||
    url.startsWith('about:') ||
    url.startsWith('chrome:') ||
    url.startsWith('chrome-extension:') ||
    url.startsWith('data:') ||
    url.startsWith('file:')
  ) {
    return null;
  }

  try {
    return new URL(url).hostname.toLowerCase() || null;
  } catch {
    // Try adding protocol for bare hostnames (e.g., "bank.com")
    try {
      return new URL('https://' + url).hostname.toLowerCase() || null;
    } catch {
      return null;
    }
  }
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

  return blockedDomains.some((pattern) => {
    const regex = globToRegex(pattern);
    return regex.test(hostname);
  });
}

/**
 * Assert that the given URL is not blocked.
 * Throws a descriptive error if the domain is on the blocklist.
 */
export function assertDomainAllowed(url: string): void {
  const config = getGlobalConfig();
  const blockedDomains = config.security?.blocked_domains;

  if (!blockedDomains || blockedDomains.length === 0) {
    return;
  }

  const hostname = extractHostname(url);
  if (!hostname) {
    return;
  }

  const matchedPattern = blockedDomains.find((pattern) => {
    const regex = globToRegex(pattern);
    return regex.test(hostname);
  });

  if (matchedPattern) {
    throw new Error(
      `Access to domain "${hostname}" is blocked by security policy (matched pattern: "${matchedPattern}"). ` +
        `Configure blocked_domains in your OpenChrome security settings to change this.`
    );
  }
}
