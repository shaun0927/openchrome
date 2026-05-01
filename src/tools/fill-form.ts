/**
 * Fill Form Tool - Composite tool that fills multiple form fields and optionally submits
 *
 * This reduces the typical pattern of multiple form_input + interact calls into one operation.
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler, ToolContext, hasBudget, throwIfAborted } from '../types/mcp';
import { getSessionManager } from '../session-manager';
import { DEFAULT_DOM_SETTLE_DELAY_MS, DEFAULT_FORM_SUBMIT_SETTLE_MS } from '../config/defaults';
import { withDomDelta } from '../utils/dom-delta';
import { withTimeout } from '../utils/with-timeout';
import { discoverFormFields, FormField, FORM_FIELD_TAG } from '../utils/element-discovery';
import { resolveElementsByAXTree, invalidateAXCache } from '../utils/ax-element-resolver';
import { getTargetId } from '../utils/puppeteer-helpers';
import { normalizeQuery } from '../utils/element-finder';
import { humanType, humanMouseMove } from '../stealth/human-behavior';
import { detectLoginOutcome, LoginDetectResult } from './login-detector';

const definition: MCPToolDefinition = {
  name: 'fill_form',
  description: 'Fill form fields and optionally submit.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'string',
        description: 'Tab ID to execute on',
      },
      fields: {
        type: 'object',
        description: 'Field label/name/placeholder to value map. Checkboxes: "true"/"false"',
        additionalProperties: {
          type: 'string',
        },
      },
      submit: {
        type: 'string',
        description: 'Submit button query after fill',
      },
      clear_first: {
        type: 'boolean',
        description: 'Clear before fill. Default: true',
      },
      waitForMs: {
        type: 'number',
        description: 'Poll timeout for dynamic fields in ms. Default: 0',
      },
      pollInterval: {
        type: 'number',
        description: 'Poll interval in ms (50-2000). Default: 300',
      },
      loginCheck: {
        type: 'string',
        enum: ['auto', 'off'],
        description: 'After submit, run a generic login-failure detector that flips success → failure when the password form is still mounted. Default: "auto". Set "off" to restore pre-#658 behavior.',
      },
    },
    required: ['tabId', 'fields'],
  },
};


const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>,
  context?: ToolContext
): Promise<MCPResult> => {
  throwIfAborted(context);
  const tabId = args.tabId as string;
  const fields = args.fields as Record<string, string | boolean | number>;
  const submit = args.submit as string | undefined;
  const clearFirst = args.clear_first !== false; // Default to true
  const waitForMs = args.waitForMs as number | undefined;
  const pollInterval = Math.min(Math.max((args.pollInterval as number) || 300, 50), 2000);
  const loginCheck: 'auto' | 'off' = (args.loginCheck === 'off') ? 'off' : 'auto';

  const sessionManager = getSessionManager();

  if (!tabId) {
    return {
      content: [{ type: 'text', text: 'Error: tabId is required' }],
      isError: true,
    };
  }

  if (!fields || typeof fields !== 'object' || Object.keys(fields).length === 0) {
    return {
      content: [{ type: 'text', text: 'Error: fields is required and must be a non-empty object' }],
      isError: true,
    };
  }

  try {
    const page = await sessionManager.getPage(sessionId, tabId, undefined, 'fill_form');
    if (!page) {
      return {
        content: [{ type: 'text', text: `Error: Tab ${tabId} not found` }],
        isError: true,
      };
    }

    // Get all form fields on the page, with optional polling for SPAs
    const maxWait = waitForMs ? Math.min(Math.max(waitForMs, 100), 30000) : 0;
    const startTime = Date.now();

    const cdpClient = sessionManager.getCDPClient();

    let formFields: FormField[] = [];
    do {
      try {
        formFields = await discoverFormFields(page, cdpClient, {
          timeout: 10000,
          toolName: 'fill_form',
        });
      } catch {
        // CDP evaluate timed out — retry if budget remains
        if (maxWait > 0 && Date.now() - startTime < maxWait) {
          await new Promise(resolve => setTimeout(resolve, pollInterval));
          continue;
        }
        break;
      }

      if (formFields.length === 0 && maxWait > 0 && Date.now() - startTime < maxWait) {
        await new Promise(resolve => setTimeout(resolve, pollInterval));
        continue;
      }
      break;
    } while (Date.now() - startTime < maxWait);

    const filledFields: string[] = [];
    const errors: string[] = [];

    const { delta, result: formResult } = await withDomDelta(page, async () => {
      let submitted = false;
      // Match and fill each requested field
      for (const [fieldKey, fieldValue] of Object.entries(fields)) {
        // Budget check: skip remaining fields if deadline approaching
        if (context && !hasBudget(context, 15_000)) {
          errors.push(`${fieldKey}: ⚠ skipped (deadline approaching)`);
          continue;
        }
        const keyLower = normalizeQuery(fieldKey);

        // ─── AX-First Resolution ───
        // Try AX tree first — the browser's accessibility engine understands all UI frameworks
        let axMatch: { backendDOMNodeId: number; rect: { x: number; y: number; width: number; height: number } } | null = null;
        try {
          const axResults = await withTimeout(
            resolveElementsByAXTree(page, cdpClient, fieldKey, {
              maxResults: 1,
              useCenter: true,
            }),
            5000,
            'fill-form-ax',
            context
          );
          if (axResults.length > 0) {
            axMatch = axResults[0];
          }
        } catch {
          throwIfAborted(context);
          // AX resolution failed — fall through to CSS discovery
        }

        if (axMatch) {
          try {
            // Scroll into view
            await cdpClient.send(page, 'DOM.scrollIntoViewIfNeeded', {
              backendNodeId: axMatch.backendDOMNodeId,
            });
            await new Promise(resolve => setTimeout(resolve, DEFAULT_DOM_SETTLE_DELAY_MS));

            // Re-resolve coordinates after scroll
            try {
              const { model } = await cdpClient.send<{ model: { content: number[] } }>(
                page, 'DOM.getBoxModel', { backendNodeId: axMatch.backendDOMNodeId }
              );
              if (model?.content && model.content.length >= 8) {
                const bx = model.content[0], by = model.content[1];
                const bw = model.content[2] - bx, bh = model.content[5] - by;
                if (bw > 0 && bh > 0) {
                  axMatch.rect = { x: bx + bw / 2, y: by + bh / 2, width: bw, height: bh };
                }
              }
            } catch { /* use original coordinates */ }

            // Click to focus (stealth: use Bézier mouse path)
            const axClickX = Math.round(axMatch.rect.x);
            const axClickY = Math.round(axMatch.rect.y);
            const isStealth = sessionManager.isStealthTarget(tabId);
            if (isStealth) await humanMouseMove(page, axClickX, axClickY);
            await page.mouse.click(axClickX, axClickY);
            await new Promise(resolve => setTimeout(resolve, DEFAULT_DOM_SETTLE_DELAY_MS));

            // Type value (AX path handles text inputs only — no checkbox/select special-casing needed here
            // since AX field discovery targets labeled fields; CSS path handles typed controls)
            if (clearFirst) {
              const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
              await page.keyboard.down(modifier);
              await page.keyboard.press('KeyA');
              await page.keyboard.up(modifier);
              await page.keyboard.press('Backspace');
            }
            // Stealth: type character-by-character with human-like delays
            if (isStealth) {
              await humanType(page, String(fieldValue));
            } else {
              await page.keyboard.type(String(fieldValue));
            }

            invalidateAXCache(getTargetId(page.target()));
            filledFields.push(`${fieldKey}: "${String(fieldValue).slice(0, 20)}${String(fieldValue).length > 20 ? '...' : ''}"`);
          } catch (e) {
            throwIfAborted(context);
            errors.push(`Failed to fill "${fieldKey}": ${e instanceof Error ? e.message : String(e)}`);
          }
          continue;
        }

        // ─── CSS Fallback ───
        // Find best matching form field
        let bestMatch: FormField | null = null;
        let bestScore = 0;

        for (const field of formFields) {
          let score = 0;
          const labelLower = field.label?.toLowerCase() || '';
          const nameLower = field.name?.toLowerCase() || '';
          const placeholderLower = field.placeholder?.toLowerCase() || '';
          const ariaLower = field.ariaLabel?.toLowerCase() || '';

          // Exact matches
          if (labelLower === keyLower) score += 100;
          if (nameLower === keyLower) score += 90;
          if (placeholderLower === keyLower) score += 80;
          if (ariaLower === keyLower) score += 80;

          // Contains matches
          if (labelLower.includes(keyLower)) score += 50;
          if (nameLower.includes(keyLower)) score += 45;
          if (placeholderLower.includes(keyLower)) score += 40;
          if (ariaLower.includes(keyLower)) score += 40;

          // Reverse contains (field name in key)
          if (keyLower.includes(labelLower) && labelLower.length > 2) score += 30;
          if (keyLower.includes(nameLower) && nameLower.length > 2) score += 25;

          // Type attribute tie-breaker (lower priority than label/name/placeholder)
          const typeLower = field.type?.toLowerCase() || '';
          if (typeLower && typeLower !== 'text') { // 'text' is too generic to match
            if (typeLower === keyLower) score += 20;
            else if (keyLower.includes(typeLower) || typeLower.includes(keyLower)) score += 10;
          }

          if (score > bestScore) {
            bestScore = score;
            bestMatch = field;
          }
        }

        if (!bestMatch || bestScore < 20) {
          const foundFieldNames = formFields.map(f => f.label || f.name || f.placeholder || f.ariaLabel || (f.type && f.type !== 'text' ? `[type=${f.type}]` : null)).filter(Boolean) as string[];
          errors.push(`Could not find field matching "${fieldKey}". Available fields: [${foundFieldNames.join(', ')}]`);
          continue;
        }

        try {
          // Scroll into view
          if (bestMatch.backendDOMNodeId) {
            await cdpClient.send(page, 'DOM.scrollIntoViewIfNeeded', {
              backendNodeId: bestMatch.backendDOMNodeId,
            });
          }

          // Click to focus (stealth: use Bézier mouse path)
          const cssClickX = Math.round(bestMatch.rect.x);
          const cssClickY = Math.round(bestMatch.rect.y);
          const isStealthCSS = sessionManager.isStealthTarget(tabId);
          if (isStealthCSS) await humanMouseMove(page, cssClickX, cssClickY);
          await page.mouse.click(cssClickX, cssClickY);
          await new Promise(resolve => setTimeout(resolve, DEFAULT_DOM_SETTLE_DELAY_MS));

          // Handle different field types
          if (bestMatch.type === 'checkbox' || bestMatch.type === 'radio') {
            // For checkbox/radio, only click if needed to match desired state
            const isChecked = await withTimeout(page.evaluate((idx: number, tagProp: string) => {
              const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
              let node;
              while ((node = walker.nextNode()) !== null) {
                const el = node as HTMLInputElement;
                if ((el as any)[tagProp] === idx) {
                  return el.checked;
                }
              }
              return false;
            }, formFields.indexOf(bestMatch), FORM_FIELD_TAG), 10000, 'fill_form', context);

            const shouldBeChecked = fieldValue === true || fieldValue === 'true' || fieldValue === '1';
            if (isChecked !== shouldBeChecked) {
              await page.mouse.click(Math.round(bestMatch.rect.x), Math.round(bestMatch.rect.y));
            }
          } else if (bestMatch.tagName === 'select') {
            // For select, use native setter for React/framework compatibility
            await withTimeout(page.evaluate((idx: number, val: string, tagProp: string) => {
              const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
              let node;
              while ((node = walker.nextNode()) !== null) {
                const el = node as HTMLSelectElement;
                if ((el as any)[tagProp] === idx) {
                  const selectSetter = Object.getOwnPropertyDescriptor(
                    window.HTMLSelectElement.prototype, 'value'
                  )?.set;
                  if (selectSetter) {
                    selectSetter.call(el, val);
                  } else {
                    el.value = val;
                  }
                  el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
                  break;
                }
              }
            }, formFields.indexOf(bestMatch), String(fieldValue), FORM_FIELD_TAG), 10000, 'fill_form', context);
          } else {
            // For text inputs/textareas
            if (clearFirst) {
              // Use Meta on macOS, Control on other platforms
              const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
              await page.keyboard.down(modifier);
              await page.keyboard.press('KeyA');
              await page.keyboard.up(modifier);
              await page.keyboard.press('Backspace');
            }
            // Stealth: type character-by-character with human-like delays
            if (isStealthCSS) {
              await humanType(page, String(fieldValue));
            } else {
              await page.keyboard.type(String(fieldValue));
            }
          }

          filledFields.push(`${fieldKey}: "${String(fieldValue).slice(0, 20)}${String(fieldValue).length > 20 ? '...' : ''}"`);
        } catch (e) {
          throwIfAborted(context);
          errors.push(`Failed to fill "${fieldKey}": ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      // Optional: Click submit button
      let loginResult: LoginDetectResult | null = null;
      // #658 (codex P1 + gemini medium): we have to decide PRE-submit whether
      // this is a login form, scoped to the *form being submitted*. Doing the
      // password-field check post-submit causes two failure modes:
      //   (a) successful logins navigate away → password field gone → success
      //       outcome is never reported.
      //   (b) pages with a persistent password form (e.g. account settings)
      //       plus an unrelated form being submitted → detector wrongly fires.
      let submitTargetIsLogin = false;
      let submitErrored = false;
      if (submit && filledFields.length > 0) {
        try {
          const submitLower = normalizeQuery(submit);

          // Find submit button + report whether its enclosing <form> contains a
          // password field. The form-scoped check rules out unrelated password
          // inputs elsewhere on the page.
          //
          // codex P2 review on #669: a submit button can target a form via the
          // `form` attribute while being OUTSIDE that form's DOM subtree. We
          // therefore prefer `el.form` (HTMLFormElement-style API) when
          // present and fall back to `el.closest('form')`.
          const submitButton = await withTimeout(page.evaluate((query: string): { x: number; y: number; formHasPassword: boolean } | null => {
            const queryLower = query.toLowerCase();
            const selectors = [
              'button[type="submit"]',
              'input[type="submit"]',
              'button',
              '[role="button"]',
              'a',
            ];

            for (const selector of selectors) {
              for (const el of document.querySelectorAll(selector)) {
                const text = (el.textContent?.toLowerCase() || '') +
                  (el.getAttribute('aria-label')?.toLowerCase() || '') +
                  ((el as HTMLInputElement).value?.toLowerCase() || '');

                if (text.includes(queryLower) || queryLower.includes(text.trim())) {
                  const rect = el.getBoundingClientRect();
                  if (rect.width > 0 && rect.height > 0) {
                    // Prefer the HTMLButtonElement / HTMLInputElement `.form`
                    // accessor — handles `<button form="loginForm">` cases that
                    // `closest('form')` misses.
                    let form: HTMLFormElement | null = (el as HTMLButtonElement | HTMLInputElement).form ?? null;
                    if (!form) form = el.closest('form');
                    const formHasPassword = form
                      ? form.querySelector('input[type="password"]') !== null
                      : false;
                    return {
                      x: rect.x + rect.width / 2,
                      y: rect.y + rect.height / 2,
                      formHasPassword,
                    };
                  }
                }
              }
            }
            return null;
          }, submitLower), 10000, 'fill_form', context);

          if (submitButton) {
            submitTargetIsLogin = submitButton.formHasPassword === true;

            // #658: capture pre-submit URL/origin BEFORE the click for the login-outcome detector.
            const preSubmitUrl = page.url();
            let preSubmitOrigin = '';
            try { preSubmitOrigin = new URL(preSubmitUrl).origin; } catch { preSubmitOrigin = ''; }

            await page.mouse.click(Math.round(submitButton.x), Math.round(submitButton.y));
            submitted = true;
            await new Promise(resolve => setTimeout(resolve, DEFAULT_FORM_SUBMIT_SETTLE_MS));

            // Run the detector iff (a) caller opted in and (b) the submitted
            // form was a login form (decided pre-submit, so success is reachable
            // even when the page has navigated away).
            //
            // codex P1 review on #669: a single 100ms probe is too short for
            // real-world latency — successful logins often stay on the form
            // for >100ms before the redirect lands, producing false 'failed'.
            // Poll up to ~3s, returning EARLY on the first definitive result
            // (success → fast; unknown stays cheap; only failed waits the
            // full window before locking in).
            if (loginCheck === 'auto' && submitTargetIsLogin) {
              const detectorDeadline = Date.now() + 3000;
              loginResult = null;
              try {
                while (Date.now() < detectorDeadline) {
                  const probe = await detectLoginOutcome(page as any, { preSubmitOrigin, preSubmitUrl });
                  if (probe.outcome === 'success') {
                    loginResult = probe;
                    break;
                  }
                  // Keep the latest snapshot as the working answer; only
                  // commit to 'failed' after the full window to give
                  // delayed redirects a chance to land.
                  loginResult = probe;
                  if (probe.outcome === 'unknown') break;
                  await new Promise(resolve => setTimeout(resolve, 200));
                }
              } catch {
                // Detector errors are non-fatal — keep whatever loginResult is set.
              }
            }
          } else {
            // No submit button = the user asked us to submit but we couldn't.
            // Per qodo Action#1: this is a real failure even if some fields filled.
            submitErrored = true;
            errors.push(`Could not find submit button matching "${submit}"`);
          }
        } catch (e) {
          throwIfAborted(context);
          submitErrored = true;
          errors.push(`Failed to submit: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return { submitted, loginResult, submitErrored };
    }, { settleMs: 200 });

    // Build compact result message
    const resultParts: string[] = [];

    if (filledFields.length > 0) {
      const submittedSuffix = formResult.submitted ? ', submitted' : '';
      resultParts.push(`\u2713 Filled ${filledFields.length} field${filledFields.length !== 1 ? 's' : ''}${submittedSuffix}`);
      // One line per field: "  fieldName: "value" → ✓"
      for (const [fieldKey, fieldValue] of Object.entries(fields)) {
        const valueStr = String(fieldValue);
        const maskedValue = fieldKey.toLowerCase().includes('password') ? '***' : valueStr.slice(0, 50);
        const filled = !errors.some(e => e.includes(`"${fieldKey}"`));
        if (filled) {
          resultParts.push(`  ${fieldKey}: "${maskedValue}" \u2192 \u2713`);
        }
      }
    }

    if (errors.length > 0) {
      resultParts.push(`Errors: ${errors.join('; ')}`);
    }

    // #658: surface login-detector outcome.
    const loginOutcome = formResult.loginResult;
    if (loginOutcome && loginOutcome.outcome === 'failed') {
      resultParts.push(`Login appears to have failed: ${loginOutcome.reason}`);
    } else if (loginOutcome && loginOutcome.outcome === 'success') {
      resultParts.push(`Login appears successful: ${loginOutcome.reason}`);
    }

    // Failure conditions (in priority order):
    //   1. Submit was attempted but the click target wasn't found OR threw —
    //      a true submit failure that should never be hidden behind partial
    //      field fills (qodo Action#1 review on #669).
    //   2. The login-outcome detector returned 'failed' (#658).
    //   3. Errors collected during fill AND no fields were filled.
    const detectorFailedLogin = loginOutcome?.outcome === 'failed';
    const submitFailed = formResult.submitErrored === true;
    const isError =
      submitFailed ||
      detectorFailedLogin ||
      (errors.length > 0 && filledFields.length === 0);

    // qodo Action#2: surface a structured errorReason at the top level so
    // callers can branch on it without parsing the result text or reaching
    // into _meta. We keep _meta for back-compat with anything that already
    // reads it.
    let errorReason: string | undefined;
    if (detectorFailedLogin) errorReason = 'login_failed';
    else if (submitFailed) errorReason = 'submit_failed';

    return {
      content: [
        {
          type: 'text',
          text: resultParts.join('\n') + (delta || ''),
        },
      ],
      isError,
      ...(errorReason ? { errorReason } : {}),
      ...(detectorFailedLogin
        ? { _meta: { errorReason: 'login_failed', loginCheckReason: loginOutcome.reason } }
        : submitFailed
          ? { _meta: { errorReason: 'submit_failed' } }
          : {}),
    } as MCPResult;
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Fill form error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
};

export function registerFillFormTool(server: MCPServer): void {
  server.registerTool('fill_form', handler, definition);
}
