/**
 * Fill Form Tool - Composite tool that fills multiple form fields and optionally submits
 *
 * This reduces the typical pattern of multiple form_input + click_element calls into one operation.
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getSessionManager } from '../session-manager';

const definition: MCPToolDefinition = {
  name: 'fill_form',
  description: 'Fill multiple form fields at once and optionally submit the form. The fields parameter maps field identifiers (label, name, placeholder, or aria-label) to values.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'string',
        description: 'Tab ID to execute on',
      },
      fields: {
        type: 'object',
        description: 'Object mapping field names/labels to values. Keys can be labels, names, placeholders, or aria-labels.',
        additionalProperties: {
          oneOf: [
            { type: 'string' },
            { type: 'boolean' },
            { type: 'number' },
          ],
        },
      },
      submit: {
        type: 'string',
        description: 'Optional: Natural language query for the submit button to click after filling (e.g., "Login", "Submit", "Save")',
      },
      clear_first: {
        type: 'boolean',
        description: 'If true, clears existing field values before entering new values (default: true)',
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

    // Get all form fields on the page
    const formFields = await page.evaluate((): FormField[] => {
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
    });

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

        if (score > bestScore) {
          bestScore = score;
          bestMatch = field;
        }
      }

      if (!bestMatch || bestScore < 20) {
        errors.push(`Could not find field matching "${fieldKey}"`);
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
        await new Promise(resolve => setTimeout(resolve, 50));

        // Handle different field types
        if (bestMatch.type === 'checkbox' || bestMatch.type === 'radio') {
          // For checkbox/radio, only click if needed to match desired state
          const isChecked = await page.evaluate((idx: number) => {
            const el = Array.from(document.querySelectorAll('*')).find((e: Element) => (e as unknown as { __formFieldIndex: number }).__formFieldIndex === idx) as HTMLInputElement;
            return el?.checked;
          }, formFields.indexOf(bestMatch));

          const shouldBeChecked = fieldValue === true || fieldValue === 'true' || fieldValue === '1';
          if (isChecked !== shouldBeChecked) {
            await page.mouse.click(Math.round(bestMatch.rect.x), Math.round(bestMatch.rect.y));
          }
        } else if (bestMatch.tagName === 'select') {
          // For select, use CDP to set value
          await page.evaluate((idx: number, val: string) => {
            const el = Array.from(document.querySelectorAll('*')).find((e: Element) => (e as unknown as { __formFieldIndex: number }).__formFieldIndex === idx) as HTMLSelectElement;
            if (el) {
              el.value = val;
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }
          }, formFields.indexOf(bestMatch), String(fieldValue));
        } else {
          // For text inputs/textareas
          if (clearFirst) {
            await page.keyboard.down('Control');
            await page.keyboard.press('KeyA');
            await page.keyboard.up('Control');
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
    let submitted = false;
    if (submit && filledFields.length > 0) {
      try {
        const submitLower = submit.toLowerCase();

        // Find submit button
        const submitButton = await page.evaluate((query: string): { x: number; y: number } | null => {
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
        }, submitLower);

        if (submitButton) {
          await page.mouse.click(Math.round(submitButton.x), Math.round(submitButton.y));
          submitted = true;
          await new Promise(resolve => setTimeout(resolve, 100));
        } else {
          errors.push(`Could not find submit button matching "${submit}"`);
        }
      } catch (e) {
        errors.push(`Failed to submit: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Build result message
    const resultParts: string[] = [];

    if (filledFields.length > 0) {
      resultParts.push(`Filled ${filledFields.length} field(s): ${filledFields.join(', ')}`);
    }

    if (submitted) {
      resultParts.push(`Submitted form via "${submit}"`);
    }

    if (errors.length > 0) {
      resultParts.push(`Errors: ${errors.join('; ')}`);
    }

    return {
      content: [
        {
          type: 'text',
          text: resultParts.join('\n'),
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
