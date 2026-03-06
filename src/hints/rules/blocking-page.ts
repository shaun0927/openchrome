/**
 * Blocking Page Rules — detect CAPTCHAs, bot-checks, and access-denied pages.
 * Fires on successful navigate results that contain a blockingPage field,
 * providing immediate guidance instead of waiting for the progress tracker.
 */

import type { HintRule } from '../hint-engine';

export const blockingPageRules: HintRule[] = [
  {
    name: 'captcha-detected',
    priority: 120, // Higher than error-recovery (100-108), lower than navigate-to-login (150)
    match(ctx) {
      if (ctx.toolName !== 'navigate') return null;
      if (ctx.isError) return null;

      // Check for structured blockingPage field in navigate response
      if (/"blockingPage"\s*:\s*\{[^}]*"type"\s*:\s*"captcha"/i.test(ctx.resultText)) {
        return (
          'Hint: CAPTCHA detected on this page. OpenChrome cannot solve CAPTCHAs programmatically. ' +
          'STOP all interaction attempts with this page. ' +
          'Ask the user to solve the CAPTCHA in their Chrome browser, then use wait_for to detect when the page changes, and resume automation.'
        );
      }

      return null;
    },
  },
  {
    name: 'bot-check-detected',
    priority: 121,
    match(ctx) {
      if (ctx.toolName !== 'navigate') return null;
      if (ctx.isError) return null;

      if (/"blockingPage"\s*:\s*\{[^}]*"type"\s*:\s*"bot-check"/i.test(ctx.resultText)) {
        return (
          'Hint: Bot verification detected. OpenChrome cannot bypass bot checks. ' +
          'Ask the user to complete the verification in their Chrome browser, then retry navigation.'
        );
      }

      return null;
    },
  },
  {
    name: 'access-denied-detected',
    priority: 122,
    match(ctx) {
      if (ctx.toolName !== 'navigate') return null;
      if (ctx.isError) return null;

      if (/"blockingPage"\s*:\s*\{[^}]*"type"\s*:\s*"access-denied"/i.test(ctx.resultText)) {
        return (
          'Hint: Access denied (403/Forbidden). The site may be blocking automated access. ' +
          'Ask the user to verify they have permission to access this URL, or try navigating in their Chrome browser first.'
        );
      }

      return null;
    },
  },
];
