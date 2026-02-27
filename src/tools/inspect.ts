/**
 * Inspect Tool - Query-focused page state extraction
 *
 * Extracts focused page state information based on a natural language query.
 * The query controls which extraction categories run — only relevant data
 * is collected and returned, saving tokens vs. full DOM reads.
 *
 * Use this instead of read_page + screenshot combos.
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getSessionManager } from '../session-manager';

const definition: MCPToolDefinition = {
  name: 'inspect',
  description:
    'Query-focused page state extraction. Returns only data relevant to your query instead of the full DOM tree. Use this instead of read_page + screenshot combos for targeted questions like "what tabs are active", "form field values", "visible error messages".',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'string',
        description: 'Tab ID to inspect',
      },
      query: {
        type: 'string',
        description:
          'What to inspect, e.g. "what tabs are active", "form field values", "visible error messages", "page structure"',
      },
      scope: {
        type: 'string',
        enum: ['interactive', 'all', 'visible'],
        description: 'Scope of elements to inspect (default: "visible")',
      },
    },
    required: ['tabId', 'query'],
  },
};

/**
 * Extraction categories that can be selectively enabled based on query keywords.
 */
type InspectCategory = 'focus' | 'tabs' | 'interactive' | 'form' | 'headings' | 'errors' | 'panels';

/**
 * Map query keywords to extraction categories.
 * Multiple keywords can map to the same category.
 */
const KEYWORD_CATEGORY_MAP: Array<[string[], InspectCategory[]]> = [
  // Focus / active element
  [['focus', 'focused', 'active element', 'selected element', 'current'], ['focus']],
  // Tab / navigation state
  [['tab', 'tabs', 'navigation', 'nav', 'menu', 'selected tab', 'active tab'], ['tabs']],
  // Interactive element counts
  [['button', 'buttons', 'link', 'links', 'interactive', 'clickable', 'elements', 'controls'], ['interactive']],
  // Form fields
  [['form', 'input', 'inputs', 'field', 'fields', 'value', 'values', 'text field', 'checkbox', 'radio', 'select', 'dropdown'], ['form']],
  // Headings / page structure
  [['heading', 'headings', 'structure', 'outline', 'sections', 'hierarchy', 'title', 'h1', 'h2', 'h3'], ['headings']],
  // Errors / warnings / alerts
  [['error', 'errors', 'warning', 'warnings', 'alert', 'alerts', 'message', 'messages', 'notification', 'status', 'validation'], ['errors']],
  // Visible content / panels
  [['content', 'panel', 'panels', 'text', 'visible', 'dialog', 'modal', 'main', 'article', 'body'], ['panels']],
  // Broad queries that need multiple categories
  [['state', 'page state', 'overview', 'summary', 'everything', 'all', 'what is on'], ['focus', 'tabs', 'interactive', 'form', 'headings', 'errors', 'panels']],
];

/**
 * Determine which categories to extract based on query keywords.
 * Returns all categories if no keywords match (backward compatible).
 */
function resolveCategories(query: string): Set<InspectCategory> {
  const queryLower = query.toLowerCase();
  const matched = new Set<InspectCategory>();

  for (const [keywords, categories] of KEYWORD_CATEGORY_MAP) {
    for (const kw of keywords) {
      if (queryLower.includes(kw)) {
        for (const cat of categories) {
          matched.add(cat);
        }
        break; // One keyword match per group is enough
      }
    }
  }

  // If no keywords matched, return all categories (backward compatible)
  if (matched.size === 0) {
    return new Set<InspectCategory>(['focus', 'tabs', 'interactive', 'form', 'headings', 'errors', 'panels']);
  }

  return matched;
}

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>
): Promise<MCPResult> => {
  const tabId = args.tabId as string;
  const query = args.query as string;
  const scope = (args.scope as string) || 'visible';

  const sessionManager = getSessionManager();

  if (!tabId) {
    return {
      content: [{ type: 'text', text: 'Error: tabId is required' }],
      isError: true,
    };
  }

  if (!query) {
    return {
      content: [{ type: 'text', text: 'Error: query is required' }],
      isError: true,
    };
  }

  // Resolve which categories to extract based on query
  const categories = resolveCategories(query);

  try {
    const page = await sessionManager.getPage(sessionId, tabId, undefined, 'inspect');
    if (!page) {
      return {
        content: [{ type: 'text', text: `Error: Tab ${tabId} not found` }],
        isError: true,
      };
    }

    // Pass category flags into the page evaluate to skip unnecessary DOM work
    const categoryFlags = {
      focus: categories.has('focus'),
      tabs: categories.has('tabs'),
      interactive: categories.has('interactive'),
      form: categories.has('form'),
      headings: categories.has('headings'),
      errors: categories.has('errors'),
      panels: categories.has('panels'),
    };

    const inspectResult = await page.evaluate(
      (scopeArg: string, cats: Record<string, boolean>) => {
        const includeAll = scopeArg === 'all';
        const interactiveOnly = scopeArg === 'interactive';

        function isVisible(el: Element): boolean {
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return false;
          const style = window.getComputedStyle(el);
          return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
        }

        // ---- Active / selected / focused elements ----
        let focusedInfo: string | null = null;
        if (cats.focus) {
          const active = document.activeElement;
          if (active && active !== document.body && active !== document.documentElement) {
            const inputEl = active as HTMLInputElement;
            const role =
              active.getAttribute('role') ||
              (active.tagName === 'BUTTON'
                ? 'button'
                : active.tagName === 'INPUT'
                  ? inputEl.type || 'textbox'
                  : active.tagName.toLowerCase());
            const name =
              active.getAttribute('aria-label') ||
              active.getAttribute('title') ||
              active.textContent?.trim().slice(0, 60) ||
              '';
            const idAttr = active.id ? `#${active.id}` : '';
            focusedInfo = `${role}${idAttr}${name ? ` "${name}"` : ''}`;
          }
        }

        // ---- Tab / navigation state ----
        interface TabInfo {
          label: string;
          selected: boolean;
          index: number;
        }
        const tabs: TabInfo[] = [];
        if (cats.tabs) {
          let tabIndex = 0;
          for (const el of document.querySelectorAll('[role="tab"]')) {
            if (!isVisible(el)) continue;
            const label =
              el.getAttribute('aria-label') || el.textContent?.trim().slice(0, 60) || '';
            const selected =
              el.getAttribute('aria-selected') === 'true' ||
              el.classList.contains('active') ||
              el.classList.contains('selected');
            tabs.push({ label, selected, index: tabIndex++ });
          }
        }

        // ---- Interactive elements summary ----
        const interactiveCounts: Record<string, number> = {};
        if (cats.interactive) {
          const interactiveSelectors = [
            'button',
            '[role="button"]',
            'a[href]',
            'input',
            'textarea',
            'select',
            '[role="combobox"]',
            '[role="listbox"]',
            '[role="checkbox"]',
            '[role="radio"]',
            '[role="switch"]',
            '[role="slider"]',
            '[role="tab"]',
            '[role="menuitem"]',
          ];
          for (const sel of interactiveSelectors) {
            try {
              let count = 0;
              for (const el of document.querySelectorAll(sel)) {
                if (includeAll || isVisible(el)) count++;
              }
              if (count > 0) {
                const label = sel
                  .replace('[role="', '')
                  .replace('"]', '')
                  .replace('[href]', '')
                  .replace('a', 'link');
                interactiveCounts[label] = (interactiveCounts[label] || 0) + count;
              }
            } catch {
              // skip bad selectors
            }
          }
        }

        // ---- Form field values ----
        interface FormField {
          type: string;
          name: string;
          value: string;
          id: string;
        }
        const formFields: FormField[] = [];
        if (cats.form && !interactiveOnly) {
          for (const el of document.querySelectorAll('input, textarea, select')) {
            if (!includeAll && !isVisible(el)) continue;
            const inputEl = el as HTMLInputElement;
            const type = inputEl.type || el.tagName.toLowerCase();
            if (type === 'hidden' || type === 'password') continue;
            const name =
              inputEl.placeholder ||
              el.getAttribute('aria-label') ||
              el.getAttribute('name') ||
              el.id ||
              '';
            let value = inputEl.value || '';
            if (el.tagName === 'SELECT') {
              const selectEl = el as HTMLSelectElement;
              value = selectEl.options[selectEl.selectedIndex]?.text || selectEl.value || '';
            }
            formFields.push({ type, name: name.slice(0, 40), value: value.slice(0, 60), id: el.id });
          }
        }

        // ---- Heading hierarchy ----
        const headings: Array<{ level: number; text: string }> = [];
        if (cats.headings) {
          for (const el of document.querySelectorAll('h1, h2, h3, h4, [role="heading"]')) {
            if (!includeAll && !isVisible(el)) continue;
            const level = parseInt(el.tagName.replace('H', '') || '2', 10);
            const text = el.textContent?.trim().slice(0, 80) || '';
            if (text) headings.push({ level, text });
            if (headings.length >= 10) break;
          }
        }

        // ---- Error / warning messages ----
        interface ErrorMessage {
          role: string;
          text: string;
        }
        const errors: ErrorMessage[] = [];
        if (cats.errors) {
          for (const el of document.querySelectorAll(
            '[role="alert"], [role="alertdialog"], [role="status"], [aria-live="assertive"], [aria-live="polite"]'
          )) {
            if (!isVisible(el)) continue;
            const text = el.textContent?.trim().slice(0, 100) || '';
            if (text) {
              errors.push({ role: el.getAttribute('role') || 'live-region', text });
            }
          }
          if (errors.length < 5) {
            for (const el of document.querySelectorAll(
              '.error, .alert, .warning, [class*="error"], [class*="alert"], [class*="warning"]'
            )) {
              if (!isVisible(el)) continue;
              const text = el.textContent?.trim().slice(0, 100) || '';
              if (text && !errors.some(e => e.text === text)) {
                errors.push({ role: 'class-match', text });
                if (errors.length >= 5) break;
              }
            }
          }
        }

        // ---- Visible text containers ----
        interface VisiblePanel {
          tag: string;
          role: string | null;
          text: string;
        }
        const visiblePanels: VisiblePanel[] = [];
        if (cats.panels && !interactiveOnly) {
          const containerSelectors = [
            '[role="tabpanel"]',
            '[role="dialog"]',
            '[role="main"]',
            'main',
            'article',
            'section',
            '[role="region"]',
          ];
          for (const sel of containerSelectors) {
            if (visiblePanels.length >= 5) break;
            try {
              for (const el of document.querySelectorAll(sel)) {
                if (!isVisible(el) || visiblePanels.length >= 5) continue;
                const text = el.textContent?.trim().slice(0, 120) || '';
                if (text.length > 20) {
                  visiblePanels.push({
                    tag: el.tagName.toLowerCase(),
                    role: el.getAttribute('role'),
                    text,
                  });
                }
              }
            } catch {
              // skip bad selectors
            }
          }
        }

        return {
          focusedInfo,
          tabs,
          interactiveCounts,
          formFields,
          headings,
          errors,
          visiblePanels,
          url: window.location.href,
          title: document.title,
        };
      },
      scope,
      categoryFlags
    );

    // Format the output — only include sections for requested categories
    const lines: string[] = [`[Inspect: "${query}"]`];

    // Tab state
    if (categories.has('tabs') && inspectResult.tabs.length > 0) {
      const activeTab = inspectResult.tabs.find(t => t.selected);
      const otherTabs = inspectResult.tabs.filter(t => !t.selected);
      if (activeTab) {
        const othersStr =
          otherTabs.length > 0
            ? `. Other tabs: ${otherTabs.map(t => t.label).join(', ')}`
            : '';
        lines.push(`[Tabs] Active: "${activeTab.label}"${othersStr}`);
      } else {
        lines.push(`[Tabs] ${inspectResult.tabs.length} tabs: ${inspectResult.tabs.map(t => t.label).join(', ')}`);
      }
    }

    // Interactive elements summary
    if (categories.has('interactive')) {
      const interactiveEntries = Object.entries(inspectResult.interactiveCounts);
      if (interactiveEntries.length > 0) {
        const summary = interactiveEntries.map(([k, v]) => `${v} ${k}s`).join(', ');
        lines.push(`[Interactive Elements] ${summary}`);
      }
    }

    // Focused element
    if (categories.has('focus') && inspectResult.focusedInfo) {
      lines.push(`[Focused] ${inspectResult.focusedInfo}`);
    }

    // Headings
    if (categories.has('headings') && inspectResult.headings.length > 0) {
      const headingStr = inspectResult.headings
        .map(h => `h${h.level}: "${h.text}"`)
        .join(' > ');
      lines.push(`[Headings] ${headingStr}`);
    }

    // Form fields
    if (categories.has('form') && inspectResult.formFields.length > 0) {
      const fieldStrs = inspectResult.formFields
        .slice(0, 8)
        .map(f => {
          const idPart = f.id ? `#${f.id}` : '';
          const namePart = f.name ? `"${f.name}"` : '';
          const valuePart = f.value ? ` = "${f.value}"` : '';
          return `${f.type}${idPart}${namePart ? ` ${namePart}` : ''}${valuePart}`;
        })
        .join(', ');
      lines.push(`[Form Fields] ${fieldStrs}`);
      if (inspectResult.formFields.length > 8) {
        lines.push(`  ... and ${inspectResult.formFields.length - 8} more fields`);
      }
    }

    // Errors
    if (categories.has('errors') && inspectResult.errors.length > 0) {
      const errorStr = inspectResult.errors
        .map(e => `"${e.text}"`)
        .join('; ');
      lines.push(`[Errors] ${inspectResult.errors.length} message(s): ${errorStr}`);
    }

    // Visible panels/content
    if (categories.has('panels') && inspectResult.visiblePanels.length > 0) {
      const panelStr = inspectResult.visiblePanels
        .map((p, i) => `Panel ${i + 1}: "${p.text}"`)
        .join(' | ');
      lines.push(`[Content] ${panelStr}`);
    }

    // Footer with page context (always included)
    lines.push(`[Page] ${inspectResult.url} | "${inspectResult.title}"`);

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Inspect error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
};

export function registerInspectTool(server: MCPServer): void {
  server.registerTool('inspect', handler, definition);
}
