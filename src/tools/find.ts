/**
 * Find Tool - Find elements by natural language query
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getSessionManager } from '../session-manager';
import { getRefIdManager } from '../utils/ref-id-manager';

const definition: MCPToolDefinition = {
  name: 'find',
  description:
    'Find elements on the page using natural language. Returns up to 20 matching elements with references.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'string',
        description: 'Tab ID to search in',
      },
      query: {
        type: 'string',
        description: 'Natural language description of what to find (e.g., "search bar", "login button")',
      },
    },
    required: ['query', 'tabId'],
  },
};

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>
): Promise<MCPResult> => {
  const tabId = args.tabId as string;
  const query = args.query as string;

  const sessionManager = getSessionManager();
  const refIdManager = getRefIdManager();

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

  try {
    const page = await sessionManager.getPage(sessionId, tabId, undefined, 'find');
    if (!page) {
      return {
        content: [{ type: 'text', text: `Error: Tab ${tabId} not found` }],
        isError: true,
      };
    }

    // Use page.evaluate to search for elements
    const queryLower = query.toLowerCase();

    interface FoundElement {
      backendDOMNodeId: number;
      role: string;
      name: string;
      tagName: string;
      type?: string;
      placeholder?: string;
      ariaLabel?: string;
      textContent?: string;
      rect: { x: number; y: number; width: number; height: number };
      score: number;
    }

    const results = await page.evaluate((searchQuery: string): FoundElement[] => {
      const elements: FoundElement[] = [];
      const domElements: Element[] = []; // Parallel array of DOM references for re-indexing
      const maxResults = 30; // Collect more candidates for better scoring

      const searchLower = searchQuery.toLowerCase();
      const queryTokens = searchLower
        .split(/\s+/)
        .filter((t) => t.length > 1)
        .filter((t) => !['the', 'a', 'an', 'to', 'for', 'of', 'in', 'on', 'at', 'and', 'or'].includes(t));

      // Helper to score an element based on query match quality
      function scoreElement(el: Element, rect: DOMRect): number {
        let score = 0;
        const inputEl = el as HTMLInputElement;
        const text = el.textContent?.toLowerCase().trim() || '';
        const ariaLabel = el.getAttribute('aria-label')?.toLowerCase() || '';
        const placeholder = inputEl.placeholder?.toLowerCase() || '';
        const title = el.getAttribute('title')?.toLowerCase() || '';
        const name = ariaLabel || title || text.slice(0, 100);
        const isContentEditable = el.getAttribute('contenteditable') === 'true';
        const role = el.getAttribute('role') ||
          (el.tagName === 'BUTTON' ? 'button' : el.tagName === 'A' ? 'link' :
           el.tagName === 'INPUT' ? inputEl.type || 'textbox'
             : isContentEditable ? 'textbox' : el.tagName.toLowerCase());

        // Exact match (highest priority)
        if (name === searchLower || text === searchLower) score += 100;

        // Aria label exact match
        if (ariaLabel === searchLower) score += 90;

        // Contains full query
        if (name.includes(searchLower)) score += 50;
        if (text.includes(searchLower)) score += 45;
        if (ariaLabel.includes(searchLower)) score += 45;

        // Token matching (for multi-word queries)
        const combinedText = `${name} ${text} ${ariaLabel} ${placeholder} ${title}`;
        const matchedTokens = queryTokens.filter(token => combinedText.includes(token));
        score += matchedTokens.length * 15;

        // Role matching bonus
        if (searchLower.includes('button') && (role === 'button' || el.tagName === 'BUTTON')) score += 30;
        if (searchLower.includes('link') && (role === 'link' || el.tagName === 'A')) score += 30;
        if (searchLower.includes('radio') && (role === 'radio' || inputEl.type === 'radio')) score += 30;
        if (searchLower.includes('checkbox') && (role === 'checkbox' || inputEl.type === 'checkbox')) score += 30;
        if (searchLower.includes('input') && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) score += 30;
        if (searchLower.includes('search') && (inputEl.type === 'search' || role === 'searchbox')) score += 30;

        // Interactive element bonus
        if (['button', 'link', 'checkbox', 'radio', 'menuitem', 'tab', 'option', 'textbox'].includes(role)) score += 20;

        // Contenteditable bonus
        if (el.getAttribute('contenteditable') === 'true') score += 15;

        // Visible and reasonably sized elements get bonus
        if (rect.width > 50 && rect.height > 20) score += 10;

        // Penalty for very small or offscreen elements
        if (rect.width < 10 || rect.height < 10) score -= 20;
        if (rect.x < 0 || rect.y < 0) score -= 10;

        return score;
      }

      // Helper to get element info with score
      function getElementInfo(el: Element): FoundElement | null {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return null;

        // Skip invisible elements
        const style = window.getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') {
          return null;
        }

        const inputEl = el as HTMLInputElement;
        const isContentEditable = el.getAttribute('contenteditable') === 'true';
        const role =
          el.getAttribute('role') ||
          (el.tagName === 'BUTTON'
            ? 'button'
            : el.tagName === 'A'
              ? 'link'
              : el.tagName === 'INPUT'
                ? inputEl.type || 'textbox'
                : isContentEditable
                  ? 'textbox'
                  : el.tagName.toLowerCase());

        return {
          backendDOMNodeId: 0,
          role,
          name:
            el.getAttribute('aria-label') ||
            el.getAttribute('title') ||
            el.textContent?.trim().slice(0, 100) ||
            '',
          tagName: el.tagName.toLowerCase(),
          type: inputEl.type,
          placeholder: inputEl.placeholder,
          ariaLabel: el.getAttribute('aria-label') || undefined,
          textContent: el.textContent?.trim().slice(0, 50),
          rect: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          },
          score: scoreElement(el, rect),
        };
      }

      // Strategy 1: Search by role/type keywords
      const roleSelectors: string[] = [];
      if (searchLower.includes('button')) {
        roleSelectors.push('button', '[role="button"]', 'input[type="submit"]');
      }
      if (searchLower.includes('link')) {
        roleSelectors.push('a', '[role="link"]');
      }
      if (
        searchLower.includes('search') ||
        searchLower.includes('input') ||
        searchLower.includes('text') ||
        searchLower.includes('editor') ||
        searchLower.includes('editable')
      ) {
        roleSelectors.push(
          'input[type="text"]',
          'input[type="search"]',
          'input:not([type])',
          'textarea',
          '[role="textbox"]',
          '[role="searchbox"]',
          '[contenteditable="true"]'
        );
      }
      if (searchLower.includes('checkbox')) {
        roleSelectors.push('input[type="checkbox"]', '[role="checkbox"]');
      }
      if (searchLower.includes('radio')) {
        roleSelectors.push('input[type="radio"]', '[role="radio"]');
      }
      if (searchLower.includes('select') || searchLower.includes('dropdown')) {
        roleSelectors.push('select', '[role="combobox"]', '[role="listbox"]');
      }
      if (searchLower.includes('image') || searchLower.includes('img')) {
        roleSelectors.push('img', '[role="img"]');
      }

      const seen = new Set<Element>();

      // First pass: role-matched elements
      for (const selector of roleSelectors) {
        if (elements.length >= maxResults) break;
        try {
          const matched = document.querySelectorAll(selector);
          for (const el of matched) {
            if (seen.has(el) || elements.length >= maxResults) continue;
            const info = getElementInfo(el);
            if (info && info.score > 0) {
              seen.add(el);
              (el as unknown as { __findIndex: number }).__findIndex = elements.length;
              domElements.push(el);
              elements.push(info);
            }
          }
        } catch {
          // Invalid selector
        }
      }

      // Second pass: all elements with text matching
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      let node = walker.nextNode();
      while (node && elements.length < maxResults) {
        const el = node as Element;
        if (!seen.has(el)) {
          const inputEl = el as HTMLInputElement;
          const text = el.textContent?.toLowerCase() || '';
          const ariaLabel = el.getAttribute('aria-label')?.toLowerCase() || '';
          const placeholder = inputEl.placeholder?.toLowerCase() || '';
          const title = el.getAttribute('title')?.toLowerCase() || '';
          const combinedText = `${text} ${ariaLabel} ${placeholder} ${title}`;

          const matchesToken = queryTokens.some((token) => combinedText.includes(token));
          const matchesFull = combinedText.includes(searchLower);

          if (matchesToken || matchesFull) {
            const info = getElementInfo(el);
            if (info && info.score > 0) {
              seen.add(el);
              (el as unknown as { __findIndex: number }).__findIndex = elements.length;
              domElements.push(el);
              elements.push(info);
            }
          }
        }
        node = walker.nextNode();
      }

      // Sort by score (highest first) and return top 20
      // Track original indices to map sorted positions back to DOM elements
      const indexed = elements.map((el, i) => ({ el, origIdx: i }));
      indexed.sort((a, b) => b.el.score - a.el.score);
      const topIndexed = indexed.slice(0, 20);

      // Clear all __findIndex markers, then re-assign in sorted order
      for (const el of domElements) {
        delete (el as unknown as { __findIndex?: number }).__findIndex;
      }
      for (let sortedPos = 0; sortedPos < topIndexed.length; sortedPos++) {
        const domEl = domElements[topIndexed[sortedPos].origIdx];
        (domEl as unknown as { __findIndex: number }).__findIndex = sortedPos;
      }

      return topIndexed.map(item => item.el);
    }, queryLower);

    // Get backend DOM node IDs for the found elements using batched approach
    const cdpClient = sessionManager.getCDPClient();

    // Step 1: Single Runtime.evaluate to collect elements in sorted order
    const { result: batchResult } = await cdpClient.send<{
      result: { objectId?: string };
    }>(page, 'Runtime.evaluate', {
      expression: `(() => {
        const results = [];
        const allEls = document.querySelectorAll('*');
        const indexedEls = [];
        for (const el of allEls) {
          if (el.__findIndex !== undefined) {
            indexedEls.push({ el, index: el.__findIndex });
          }
        }
        // Sort by __findIndex to match results array order
        indexedEls.sort((a, b) => a.index - b.index);
        return indexedEls.map(e => e.el);
      })()`,
      returnByValue: false,
    });

    if (batchResult.objectId) {
      // Step 2: Get array properties to get individual element references
      const { result: properties } = await cdpClient.send<{
        result: Array<{ name: string; value: { objectId?: string } }>;
      }>(page, 'Runtime.getProperties', {
        objectId: batchResult.objectId,
        ownProperties: true,
      });

      // Step 3: Parallel DOM.describeNode for each element
      const describePromises: Promise<void>[] = [];
      for (const prop of properties) {
        const index = parseInt(prop.name, 10);
        if (isNaN(index) || index >= results.length || !prop.value?.objectId) continue;

        describePromises.push(
          cdpClient.send<{ node: { backendNodeId: number } }>(
            page,
            'DOM.describeNode',
            { objectId: prop.value.objectId }
          ).then(({ node }) => {
            results[index].backendDOMNodeId = node.backendNodeId;
          }).catch(() => {
            // Skip if we can't get the backend node ID
          })
        );
      }

      await Promise.all(describePromises);
    }

    // Generate refs for found elements (already sorted by score)
    const output: string[] = [];
    for (const el of results) {
      if (el.backendDOMNodeId) {
        const refId = refIdManager.generateRef(
          sessionId,
          tabId,
          el.backendDOMNodeId,
          el.role,
          el.name,
          el.tagName,
          el.textContent
        );

        // Include score in output for transparency
        const scoreLabel = el.score >= 100 ? '★★★' : el.score >= 50 ? '★★' : el.score >= 20 ? '★' : '';
        output.push(
          `[${refId}] ${el.role}: "${el.name}" at (${Math.round(el.rect.x)}, ${Math.round(el.rect.y)}) ${scoreLabel}`.trim()
        );
      }
    }

    if (output.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: `No elements found matching "${query}"`,
          },
        ],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: `Found ${output.length} elements matching "${query}":\n\n${output.join('\n')}`,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Find error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
};

export function registerFindTool(server: MCPServer): void {
  server.registerTool('find', handler, definition);
}
