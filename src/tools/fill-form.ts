/**
 * Fill Form Tool - Composite tool that fills multiple form fields and optionally submits
 *
 * This reduces the typical pattern of multiple form_input + click_element calls into one operation.
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getSessionManager } from '../session-manager';
import { DEFAULT_DOM_SETTLE_DELAY_MS, DEFAULT_FORM_SUBMIT_SETTLE_MS } from '../config/defaults';
import { withDomDelta } from '../utils/dom-delta';
import { withTimeout } from '../utils/with-timeout';

const definition: MCPToolDefinition = {
  name: 'fill_form',
  description: 'Fill multiple form fields at once and optionally submit.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'string',
        description: 'Tab ID to execute on',
      },
      fields: {
        type: 'object',
        description: 'Map of field labels/names/placeholders to values (string). For checkboxes use "true"/"false".',
        additionalProperties: {
          type: 'string',
        },
      },
      submit: {
        type: 'string',
        description: 'Submit button query, e.g. "Login", "Save"',
      },
      clear_first: {
        type: 'boolean',
        description: 'Clear fields before filling. Default: true',
      },
      waitForMs: {
        type: 'number',
        description: 'Max time to wait for form fields to appear (useful for SPAs). Default: 0 (no polling). Set to 1500 for SPA support.',
      },
      pollInterval: {
        type: 'number',
        description: 'Interval between polls in ms when waiting for fields (50-2000). Default: 300',
      },
    },
    required: ['tabId', 'fields'],
  },
};

interface FormField {
  backendDOMNodeId: number;
  fieldName: string;
  tagName: string;
  type?: string;
  name?: string;
  placeholder?: string;
  ariaLabel?: string;
  label?: string;
  rect: { x: number; y: number; width: number; height: number };
}

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>
): Promise<MCPResult> => {
  const tabId = args.tabId as string;
  const fields = args.fields as Record<string, string | boolean | number>;
  const submit = args.submit as string | undefined;
  const clearFirst = args.clear_first !== false; // Default to true
  const waitForMs = args.waitForMs as number | undefined;
  const pollInterval = Math.min(Math.max((args.pollInterval as number) || 300, 50), 2000);

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

    let formFields: FormField[] = [];
    do {
      try {
      formFields = await withTimeout(page.evaluate((): FormField[] => {
        const fields: FormField[] = [];

        // Helper to get associated label
        function getLabel(el: Element): string | undefined {
          const inputEl = el as HTMLInputElement;
          // Check for explicit label
          if (inputEl.id) {
            const label = document.querySelector(`label[for="${inputEl.id}"]`);
            if (label) return label.textContent?.trim();
          }
          // Check for wrapping label
          const parent = el.closest('label');
          if (parent) {
            const labelText = parent.textContent?.trim() || '';
            const inputText = el.textContent?.trim() || '';
            return labelText.replace(inputText, '').trim();
          }
          // Check for preceding label sibling
          const prev = el.previousElementSibling;
          if (prev?.tagName === 'LABEL') {
            return prev.textContent?.trim();
          }
          return undefined;
        }

        // Find all input-like elements
        const selectors = [
          'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="image"])',
          'textarea',
          'select',
          '[contenteditable="true"]',
          '[role="textbox"]',
          '[role="combobox"]',
        ];

        let index = 0;
        for (const selector of selectors) {
          try {
            for (const el of document.querySelectorAll(selector)) {
              const rect = el.getBoundingClientRect();
              if (rect.width === 0 || rect.height === 0) continue;

              const style = window.getComputedStyle(el);
              if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') continue;

              const inputEl = el as HTMLInputElement;

              fields.push({
                backendDOMNodeId: 0,
                fieldName: getLabel(el) || inputEl.name || inputEl.placeholder || inputEl.getAttribute('aria-label') || `field_${index}`,
                tagName: el.tagName.toLowerCase(),
                type: inputEl.type,
                name: inputEl.name,
                placeholder: inputEl.placeholder,
                ariaLabel: el.getAttribute('aria-label') || undefined,
                label: getLabel(el),
                rect: {
                  x: rect.x + rect.width / 2,
                  y: rect.y + rect.height / 2,
                  width: rect.width,
                  height: rect.height,
                },
              });

              // Tag element for later reference
              (el as unknown as { __formFieldIndex: number }).__formFieldIndex = index++;
            }
          } catch {
            // Invalid selector
          }
        }

        return fields;
      }), 10000, 'fill_form');
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
    const cdpClient = sessionManager.getCDPClient();

    // Get backend node IDs
    for (let i = 0; i < formFields.length; i++) {
      try {
        const { result } = await cdpClient.send<{
          result: { objectId?: string };
        }>(page, 'Runtime.evaluate', {
          expression: `document.querySelectorAll('*').find(el => el.__formFieldIndex === ${i})`,
          returnByValue: false,
        });

        if (result.objectId) {
          const { node } = await cdpClient.send<{
            node: { backendNodeId: number };
          }>(page, 'DOM.describeNode', {
            objectId: result.objectId,
          });
          formFields[i].backendDOMNodeId = node.backendNodeId;
        }
      } catch {
        // Skip
      }
    }

    const { delta, result: formResult } = await withDomDelta(page, async () => {
      let submitted = false;
      // Match and fill each requested field
      for (const [fieldKey, fieldValue] of Object.entries(fields)) {
        const keyLower = fieldKey.toLowerCase();

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

          // Click to focus
          await page.mouse.click(Math.round(bestMatch.rect.x), Math.round(bestMatch.rect.y));
          await new Promise(resolve => setTimeout(resolve, DEFAULT_DOM_SETTLE_DELAY_MS));

          // Handle different field types
          if (bestMatch.type === 'checkbox' || bestMatch.type === 'radio') {
            // For checkbox/radio, only click if needed to match desired state
            const isChecked = await withTimeout(page.evaluate((idx: number) => {
              const el = Array.from(document.querySelectorAll('*')).find((e: Element) => (e as unknown as { __formFieldIndex: number }).__formFieldIndex === idx) as HTMLInputElement;
              return el?.checked;
            }, formFields.indexOf(bestMatch)), 10000, 'fill_form');

            const shouldBeChecked = fieldValue === true || fieldValue === 'true' || fieldValue === '1';
            if (isChecked !== shouldBeChecked) {
              await page.mouse.click(Math.round(bestMatch.rect.x), Math.round(bestMatch.rect.y));
            }
          } else if (bestMatch.tagName === 'select') {
            // For select, use CDP to set value
            await withTimeout(page.evaluate((idx: number, val: string) => {
              const el = Array.from(document.querySelectorAll('*')).find((e: Element) => (e as unknown as { __formFieldIndex: number }).__formFieldIndex === idx) as HTMLSelectElement;
              if (el) {
                el.value = val;
                el.dispatchEvent(new Event('change', { bubbles: true }));
              }
            }, formFields.indexOf(bestMatch), String(fieldValue)), 10000, 'fill_form');
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
            await page.keyboard.type(String(fieldValue));
          }

          filledFields.push(`${fieldKey}: "${String(fieldValue).slice(0, 20)}${String(fieldValue).length > 20 ? '...' : ''}"`);
        } catch (e) {
          errors.push(`Failed to fill "${fieldKey}": ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      // Optional: Click submit button
      if (submit && filledFields.length > 0) {
        try {
          const submitLower = submit.toLowerCase();

          // Find submit button
          const submitButton = await withTimeout(page.evaluate((query: string): { x: number; y: number } | null => {
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
                    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
                  }
                }
              }
            }
            return null;
          }, submitLower), 10000, 'fill_form');

          if (submitButton) {
            await page.mouse.click(Math.round(submitButton.x), Math.round(submitButton.y));
            submitted = true;
            await new Promise(resolve => setTimeout(resolve, DEFAULT_FORM_SUBMIT_SETTLE_MS));
          } else {
            errors.push(`Could not find submit button matching "${submit}"`);
          }
        } catch (e) {
          errors.push(`Failed to submit: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return { submitted };
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

    return {
      content: [
        {
          type: 'text',
          text: resultParts.join('\n') + (delta || ''),
        },
      ],
      isError: errors.length > 0 && filledFields.length === 0,
    };
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
