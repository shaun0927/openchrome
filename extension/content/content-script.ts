/**
 * Content Script - Injected into web pages
 *
 * This script runs in the context of web pages and provides:
 * 1. DOM access for tools that need it
 * 2. Communication bridge with the service worker
 * 3. Element reference tracking for find/form_input tools
 */

// Element reference map for tracking found elements
const elementRefMap = new Map<string, Element>();
let refCounter = 0;

/**
 * Generate a unique reference ID for an element
 */
function generateRef(element: Element): string {
  const ref = `ref_${++refCounter}`;
  elementRefMap.set(ref, element);
  return ref;
}

/**
 * Get an element by its reference ID
 */
function getElementByRef(ref: string): Element | undefined {
  return elementRefMap.get(ref);
}

/**
 * Clear old references to prevent memory leaks
 */
function cleanupRefs(): void {
  // Keep only recent refs (last 1000)
  if (elementRefMap.size > 1000) {
    const entries = Array.from(elementRefMap.entries());
    const toDelete = entries.slice(0, entries.length - 1000);
    for (const [ref] of toDelete) {
      elementRefMap.delete(ref);
    }
  }
}

/**
 * Handle messages from the service worker
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'get-element-by-ref': {
      const element = getElementByRef(message.ref);
      if (element) {
        const rect = element.getBoundingClientRect();
        sendResponse({
          found: true,
          tagName: element.tagName,
          rect: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          },
        });
      } else {
        sendResponse({ found: false });
      }
      break;
    }

    case 'scroll-to-ref': {
      const element = getElementByRef(message.ref);
      if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        sendResponse({ success: true });
      } else {
        sendResponse({ success: false, error: 'Element not found' });
      }
      break;
    }

    case 'click-ref': {
      const element = getElementByRef(message.ref);
      if (element && element instanceof HTMLElement) {
        element.click();
        sendResponse({ success: true });
      } else {
        sendResponse({ success: false, error: 'Element not found or not clickable' });
      }
      break;
    }

    case 'set-value-ref': {
      const element = getElementByRef(message.ref);
      if (element) {
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
          element.value = message.value;
          element.dispatchEvent(new Event('input', { bubbles: true }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
          sendResponse({ success: true });
        } else if (element instanceof HTMLSelectElement) {
          element.value = message.value;
          element.dispatchEvent(new Event('change', { bubbles: true }));
          sendResponse({ success: true });
        } else {
          sendResponse({ success: false, error: 'Element is not an input' });
        }
      } else {
        sendResponse({ success: false, error: 'Element not found' });
      }
      break;
    }

    case 'find-elements': {
      const { selector, query } = message;
      const results: Array<{
        ref: string;
        tagName: string;
        text: string;
        rect: DOMRect;
      }> = [];

      // Query elements
      const elements = selector
        ? document.querySelectorAll(selector)
        : document.querySelectorAll('*');

      for (const element of elements) {
        if (results.length >= 20) break;

        const text = (element.textContent || '').toLowerCase();
        const queryLower = query?.toLowerCase() || '';

        // Check if element matches query
        if (!query || text.includes(queryLower)) {
          const ref = generateRef(element);
          const rect = element.getBoundingClientRect();

          results.push({
            ref,
            tagName: element.tagName.toLowerCase(),
            text: (element.textContent || '').slice(0, 100),
            rect: {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
            } as DOMRect,
          });
        }
      }

      cleanupRefs();
      sendResponse({ results });
      break;
    }

    case 'get-page-info': {
      sendResponse({
        url: window.location.href,
        title: document.title,
        readyState: document.readyState,
      });
      break;
    }

    default:
      sendResponse({ error: 'Unknown message type' });
  }

  return true; // Will respond asynchronously
});

/**
 * Notify service worker that content script is ready
 */
function notifyReady(): void {
  chrome.runtime.sendMessage({
    type: 'content-script-ready',
    url: window.location.href,
  }).catch(() => {
    // Extension context might not be available
  });
}

// Notify when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', notifyReady);
} else {
  notifyReady();
}

// Periodic cleanup
setInterval(cleanupRefs, 60000);

console.log('[Claude Chrome Parallel] Content script loaded');
