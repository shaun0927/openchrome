/**
 * Pagination Detector - Detects pagination patterns in browser pages.
 *
 * Runs DOM inspection via page.evaluate() and returns a structured
 * PaginationInfo describing the type of pagination and suggested strategy.
 */

import type { Page } from 'puppeteer-core';

export interface PaginationInfo {
  type: 'numbered' | 'next_button' | 'load_more' | 'infinite_scroll' | 'cursor' | 'viewer' | 'none';
  hasNext: boolean;
  hasPrev: boolean;
  currentPage?: number;
  totalPages?: number;
  nextAction?: {
    tool: string;
    args: Record<string, unknown>;
  };
  urlPattern?: string;
  suggestedStrategy: string;
}

export async function detectPagination(page: Page, tabId: string): Promise<PaginationInfo> {
  try {
    const result = await page.evaluate(() => {
      interface DetectResult {
        type: 'numbered' | 'next_button' | 'load_more' | 'infinite_scroll' | 'cursor' | 'viewer' | 'none';
        hasNext: boolean;
        hasPrev: boolean;
        currentPage?: number;
        totalPages?: number;
        nextSelector?: string;
        urlPattern?: string;
        urlTemplate?: string;
      }

      // ---------------------------------------------------------------
      // 1. PDF/Slide Viewer detection
      // ---------------------------------------------------------------
      const hasViewerContainer =
        !!document.querySelector('#viewerContainer') ||
        !!document.querySelector('.pdfViewer') ||
        !!document.querySelector('[data-page-number]');

      const canvasInPage =
        !!document.querySelector('.page canvas') ||
        !!document.querySelector('[id^="page"] canvas') ||
        !!document.querySelector('canvas[aria-label]');

      // Page count text patterns: "Page X of Y", "X / Y", "X/Y"
      const bodyText = document.body.innerText || '';
      const pageCountMatch =
        bodyText.match(/[Pp]age\s+(\d+)\s+of\s+(\d+)/) ||
        bodyText.match(/(\d+)\s*\/\s*(\d+)/) ||
        null;

      // Slide presentation viewers
      const hasRevealJs = !!(window as any).Reveal;
      const hasGoogleSlides = !!document.querySelector('.punch-present-iframe, [data-slide-id]');
      const hasFeatpaper = !!document.querySelector('[class*="featpaper"], [class*="slideshare"]');

      if (hasViewerContainer || canvasInPage || hasRevealJs || hasGoogleSlides || hasFeatpaper) {
        let currentPage: number | undefined;
        let totalPages: number | undefined;

        if (pageCountMatch) {
          currentPage = parseInt(pageCountMatch[1], 10);
          totalPages = parseInt(pageCountMatch[2], 10);
        } else {
          // Try numeric inputs used in PDF viewers
          const pageInput = document.querySelector<HTMLInputElement>(
            'input[id*="page"], input[aria-label*="page" i], input[aria-label*="Page" i]'
          );
          if (pageInput) {
            const val = parseInt(pageInput.value, 10);
            if (!isNaN(val)) currentPage = val;
          }

          // Total pages from span patterns
          const totalEl = document.querySelector(
            '#numPages, [id*="numPages"], [class*="numPages"], [class*="total-pages"]'
          );
          if (totalEl && totalEl.textContent) {
            const n = parseInt(totalEl.textContent.replace(/\D/g, ''), 10);
            if (!isNaN(n) && n > 0) totalPages = n;
          }
        }

        const hasNext = totalPages === undefined || (currentPage !== undefined && currentPage < totalPages);
        const hasPrev = currentPage !== undefined && currentPage > 1;

        return {
          type: 'viewer' as const,
          hasNext,
          hasPrev,
          currentPage,
          totalPages,
        } as DetectResult;
      }

      // ---------------------------------------------------------------
      // 2. Numbered pagination
      // ---------------------------------------------------------------
      const paginationContainer =
        document.querySelector('.pagination') ||
        document.querySelector('[role="navigation"][aria-label*="page" i]') ||
        document.querySelector('[role="navigation"][aria-label*="pagination" i]') ||
        document.querySelector('nav.pagination') ||
        document.querySelector('[class*="pagination"]');

      if (paginationContainer) {
        const links = Array.from(paginationContainer.querySelectorAll('a, button'));
        const pageNumbers = links
          .map((el) => parseInt((el.textContent || '').trim(), 10))
          .filter((n) => !isNaN(n) && n > 0);

        const isSequential =
          pageNumbers.length >= 2 &&
          pageNumbers.every((n, i) => i === 0 || n === pageNumbers[i - 1] + 1);

        if (isSequential || pageNumbers.length >= 3) {
          // Try to find current page
          const activeEl =
            paginationContainer.querySelector('[aria-current="page"]') ||
            paginationContainer.querySelector('.active') ||
            paginationContainer.querySelector('[class*="current"]') ||
            paginationContainer.querySelector('[class*="active"]');

          let currentPage: number | undefined;
          if (activeEl) {
            const n = parseInt((activeEl.textContent || '').trim(), 10);
            if (!isNaN(n)) currentPage = n;
          }

          const totalPages = pageNumbers.length > 0 ? Math.max(...pageNumbers) : undefined;
          const hasNext = currentPage !== undefined && totalPages !== undefined
            ? currentPage < totalPages
            : true;
          const hasPrev = currentPage !== undefined ? currentPage > 1 : false;

          // URL pattern detection
          const url = window.location.href;
          let urlPattern: string | undefined;
          let urlTemplate: string | undefined;
          const pageParamMatch = url.match(/[?&]page=(\d+)/);
          const offsetParamMatch = url.match(/[?&]offset=(\d+)/);
          const pathPageMatch = url.match(/\/page\/(\d+)/);

          if (pageParamMatch) {
            urlPattern = '?page=N';
            urlTemplate = url.replace(/([?&]page=)\d+/, '$1{page}');
          } else if (offsetParamMatch) {
            urlPattern = '?offset=N';
            urlTemplate = url.replace(/([?&]offset=)\d+/, '$1{offset}');
          } else if (pathPageMatch) {
            urlPattern = '/page/N';
            urlTemplate = url.replace(/\/page\/\d+/, '/page/{page}');
          }

          return {
            type: 'numbered' as const,
            hasNext,
            hasPrev,
            currentPage,
            totalPages,
            urlPattern,
            urlTemplate,
          } as DetectResult;
        }
      }

      // ---------------------------------------------------------------
      // 3. Next/Prev button detection
      // ---------------------------------------------------------------
      const nextButtonSelectors = [
        '[aria-label*="next" i]',
        '[rel="next"]',
        '.next-page',
        '.next',
        '[class*="next-page"]',
        '[class*="nextPage"]',
        '[class*="btn-next"]',
      ];

      let nextSelector: string | undefined;
      for (const sel of nextButtonSelectors) {
        const el = document.querySelector(sel);
        if (el && (el as HTMLElement).offsetParent !== null) {
          // Visible element
          const tag = el.tagName.toLowerCase();
          const classes = Array.from(el.classList).slice(0, 2).join('.');
          nextSelector = classes ? `${tag}.${classes}` : sel;
          break;
        }
      }

      // Also check buttons with "next" text
      if (!nextSelector) {
        const buttons = Array.from(document.querySelectorAll('button, a'));
        for (const btn of buttons) {
          const text = (btn.textContent || '').trim().toLowerCase();
          if (text === 'next' || text === 'next page' || text === '›' || text === '»' || text === '>') {
            const tag = btn.tagName.toLowerCase();
            const classes = Array.from(btn.classList).slice(0, 2).join('.');
            nextSelector = classes ? `${tag}.${classes}` : tag;
            break;
          }
        }
      }

      if (nextSelector) {
        // Check for prev
        const prevExists =
          !!document.querySelector('[aria-label*="prev" i]') ||
          !!document.querySelector('[rel="prev"]') ||
          !!document.querySelector('.prev-page') ||
          !!document.querySelector('.prev') ||
          !!document.querySelector('[class*="prev-page"]');

        return {
          type: 'next_button' as const,
          hasNext: true,
          hasPrev: prevExists,
          nextSelector,
        } as DetectResult;
      }

      // ---------------------------------------------------------------
      // 4. Load More button detection
      // ---------------------------------------------------------------
      const loadMorePhrases = ['load more', 'show more', 'see more', '더 보기', 'load more results', 'view more'];
      const allButtons = Array.from(document.querySelectorAll('button, a, [role="button"]'));
      let loadMoreSelector: string | undefined;

      for (const btn of allButtons) {
        const text = (btn.textContent || '').trim().toLowerCase();
        if (loadMorePhrases.some((phrase) => text === phrase || text.startsWith(phrase))) {
          const tag = btn.tagName.toLowerCase();
          const classes = Array.from(btn.classList).slice(0, 2).join('.');
          loadMoreSelector = classes ? `${tag}.${classes}` : tag;
          break;
        }
      }

      if (loadMoreSelector) {
        return {
          type: 'load_more' as const,
          hasNext: true,
          hasPrev: false,
          nextSelector: loadMoreSelector,
        } as DetectResult;
      }

      // ---------------------------------------------------------------
      // 5. Infinite scroll detection
      // ---------------------------------------------------------------
      const isScrollable = document.body.scrollHeight > 1.5 * window.innerHeight;
      const hasSentinel =
        !!document.querySelector('[class*="sentinel"]') ||
        !!document.querySelector('[class*="infinite"]') ||
        !!document.querySelector('[data-infinite]') ||
        !!document.querySelector('[class*="load-trigger"]');

      if (isScrollable && (hasSentinel || document.body.scrollHeight > 2 * window.innerHeight)) {
        return {
          type: 'infinite_scroll' as const,
          hasNext: true,
          hasPrev: false,
        } as DetectResult;
      }

      // ---------------------------------------------------------------
      // 6. None / fallback
      // ---------------------------------------------------------------
      return {
        type: 'none' as const,
        hasNext: false,
        hasPrev: false,
      } as DetectResult;
    });

    // Build the final PaginationInfo with nextAction and suggestedStrategy
    const info: PaginationInfo = {
      type: result.type,
      hasNext: result.hasNext,
      hasPrev: result.hasPrev,
      currentPage: result.currentPage,
      totalPages: result.totalPages,
      urlPattern: result.urlPattern,
      suggestedStrategy: '',
    };

    switch (result.type) {
      case 'viewer': {
        const n = result.totalPages;
        if (n !== undefined) {
          info.suggestedStrategy = `This is a paginated viewer with ${n} pages. Use batch_paginate(strategy='keyboard', totalPages=${n}) to extract all pages in a single call.`;
        } else {
          info.suggestedStrategy = "This is a paginated viewer. Use batch_paginate(strategy='keyboard') to extract all pages via keyboard navigation.";
        }
        info.nextAction = { tool: 'computer', args: { action: 'key', text: 'ArrowRight' } };
        break;
      }

      case 'numbered': {
        if (result.urlPattern && result.urlTemplate && result.totalPages) {
          info.suggestedStrategy = `URL pagination detected (${result.urlPattern}). Use batch_paginate(strategy='url', urlTemplate='${result.urlTemplate}', totalPages=${result.totalPages}) for parallel extraction.`;
        } else if (result.totalPages) {
          info.suggestedStrategy = `Numbered pagination detected with ${result.totalPages} pages. Use batch_paginate(strategy='click') to iterate through all pages.`;
        } else {
          info.suggestedStrategy = "Numbered pagination detected. Use batch_paginate(strategy='click') to iterate through pages.";
        }
        break;
      }

      case 'next_button': {
        const sel = result.nextSelector ?? '[aria-label*="next" i]';
        info.suggestedStrategy = `Next button detected. Use batch_paginate(strategy='click', nextSelector='${sel}') for server-side bulk extraction.`;
        info.nextAction = { tool: 'click', args: { selector: sel } };
        break;
      }

      case 'load_more': {
        const sel = result.nextSelector ?? 'button';
        info.suggestedStrategy = `'Load more' button found. Use batch_paginate(strategy='click', nextSelector='${sel}') for bulk extraction.`;
        info.nextAction = { tool: 'click', args: { selector: sel } };
        break;
      }

      case 'infinite_scroll': {
        info.suggestedStrategy = "Infinite scroll detected. Use batch_paginate(strategy='scroll') to auto-scroll and extract all content.";
        break;
      }

      case 'cursor':
      case 'none':
      default: {
        info.suggestedStrategy = 'No pagination detected. All content is available on the current page.';
        break;
      }
    }

    return info;
  } catch {
    // Detection failures are non-fatal — return none
    return {
      type: 'none',
      hasNext: false,
      hasPrev: false,
      suggestedStrategy: 'Pagination detection failed.',
    };
  }
}
