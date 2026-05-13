/**
 * In-page overlay source for `element_pick` (#899).
 *
 * The string is injected via CDP Runtime.evaluate in an isolated world by the
 * future MCP tool. It intentionally has no imports/build step so CSP-strict
 * pages can still run it through DevTools evaluation. The script exposes a
 * small `window.__openchromeElementPick` controller used by the tool to start,
 * cancel, and collect a single pick result.
 */
export const ELEMENT_PICK_OVERLAY_SOURCE = String.raw`
(() => {
  const KEY = '__openchromeElementPick';
  if (window[KEY] && window[KEY].cleanup) {
    try { window[KEY].cleanup('replaced'); } catch {}
  }

  const state = {
    active: false,
    result: null,
    highlight: null,
    capture: null,
    timeoutId: null,
    lastHover: null,
  };

  const zIndex = '2147483647';

  function removeNode(node) {
    try { if (node && node.parentNode) node.parentNode.removeChild(node); } catch {}
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(String(value));
    return String(value).replace(/[^a-zA-Z0-9_-]/g, (ch) => '\\' + ch);
  }

  function nthOfType(el) {
    let n = 1;
    let prev = el && el.previousElementSibling;
    while (prev) {
      if (prev.tagName === el.tagName) n++;
      prev = prev.previousElementSibling;
    }
    return n;
  }

  function ancestryFor(el) {
    const nodes = [];
    let node = el;
    while (node && node.nodeType === 1 && nodes.length < 8) {
      const attrs = {};
      for (const name of ['data-testid', 'data-test', 'data-cy', 'name', 'aria-label', 'placeholder', 'type']) {
        const value = node.getAttribute && node.getAttribute(name);
        if (value) attrs[name] = String(value).slice(0, 200);
      }
      nodes.unshift({
        tagName: String(node.tagName || '').toLowerCase(),
        id: node.id || null,
        classes: Array.from(node.classList || []).slice(0, 4),
        attributes: attrs,
        nthOfType: nthOfType(node),
      });
      if (node.id) break;
      node = node.parentElement;
    }
    return nodes;
  }

  function cssPathFor(el) {
    return ancestryFor(el).map((node) => {
      const tag = node.tagName || 'element';
      if (node.id) return tag + '#' + cssEscape(node.id);
      for (const attr of ['data-testid', 'data-test', 'data-cy', 'name', 'aria-label']) {
        const value = node.attributes && node.attributes[attr];
        if (value) return tag + '[' + attr + '="' + String(value).replace(/"/g, '\\"') + '"]';
      }
      return tag + ':nth-of-type(' + (node.nthOfType || 1) + ')';
    }).join(' > ');
  }

  function collect(el) {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return {
      ancestry: ancestryFor(el),
      cssPath: cssPathFor(el),
      role: el.getAttribute('role') || undefined,
      accessibleName: el.getAttribute('aria-label') || el.getAttribute('alt') || undefined,
      text: String(el.textContent || '').trim().slice(0, 200),
      boundingBox: {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      },
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
      },
      computedStyle: {
        display: style.display,
        position: style.position,
        visibility: style.visibility,
        opacity: style.opacity,
        'pointer-events': style.pointerEvents,
        cursor: style.cursor,
      },
      domSnippet: String(el.outerHTML || '').slice(0, 4096),
      pageUrl: location.href,
      pageTitle: document.title,
      pickedAt: Date.now(),
    };
  }

  function setResult(result) {
    state.result = result;
    cleanup(result && result.error ? result.error : 'done');
  }

  function cleanup(reason) {
    if (!state.active && !state.highlight && !state.capture) return;
    state.active = false;
    if (state.timeoutId) clearTimeout(state.timeoutId);
    state.timeoutId = null;
    document.removeEventListener('mousemove', onMouseMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('keydown', onKeyDown, true);
    removeNode(state.highlight);
    removeNode(state.capture);
    state.highlight = null;
    state.capture = null;
    if (!state.result && reason && reason !== 'done') {
      state.result = { success: false, error: reason };
    }
  }

  function ensureOverlay() {
    const highlight = document.createElement('div');
    highlight.setAttribute('data-openchrome-element-pick', 'highlight');
    highlight.style.cssText = [
      'position:fixed',
      'z-index:' + zIndex,
      'pointer-events:none',
      'border:2px solid #3b82f6',
      'background:rgba(59,130,246,0.12)',
      'box-sizing:border-box',
      'display:none',
    ].join(';');

    const capture = document.createElement('div');
    capture.setAttribute('data-openchrome-element-pick', 'capture');
    capture.style.cssText = [
      'position:fixed',
      'inset:0',
      'z-index:' + zIndex,
      'cursor:crosshair',
      'background:transparent',
      'pointer-events:auto',
    ].join(';');

    document.documentElement.appendChild(highlight);
    document.documentElement.appendChild(capture);
    state.highlight = highlight;
    state.capture = capture;
  }

  function elementFromEvent(event) {
    const captureDisplay = state.capture && state.capture.style.display;
    if (state.capture) state.capture.style.display = 'none';
    const el = document.elementFromPoint(event.clientX, event.clientY);
    if (state.capture) state.capture.style.display = captureDisplay || '';
    return el && el.nodeType === 1 ? el : null;
  }

  function onMouseMove(event) {
    if (!state.active) return;
    const el = elementFromEvent(event);
    state.lastHover = el;
    if (!el || !state.highlight) return;
    const rect = el.getBoundingClientRect();
    state.highlight.style.display = rect.width > 0 && rect.height > 0 ? 'block' : 'none';
    state.highlight.style.left = Math.round(rect.x) + 'px';
    state.highlight.style.top = Math.round(rect.y) + 'px';
    state.highlight.style.width = Math.round(rect.width) + 'px';
    state.highlight.style.height = Math.round(rect.height) + 'px';
  }

  function onClick(event) {
    if (!state.active) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.stopImmediatePropagation) event.stopImmediatePropagation();
    const el = elementFromEvent(event) || state.lastHover;
    if (!el) return setResult({ success: false, error: 'element_not_found' });
    setResult({ success: true, element: collect(el) });
  }

  function onKeyDown(event) {
    if (!state.active) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (event.stopImmediatePropagation) event.stopImmediatePropagation();
      setResult({ success: false, error: 'cancelled' });
    }
  }

  window[KEY] = {
    start(options) {
      if (state.active) return { success: false, error: 'already_picking' };
      state.result = null;
      state.active = true;
      ensureOverlay();
      document.addEventListener('mousemove', onMouseMove, true);
      document.addEventListener('click', onClick, true);
      document.addEventListener('keydown', onKeyDown, { capture: true, passive: false });
      window.addEventListener('keydown', onKeyDown, { capture: true, passive: false });
      const timeoutMs = Math.max(1, Math.min(Number(options && options.timeoutMs) || 60000, 300000));
      state.timeoutId = setTimeout(() => setResult({ success: false, error: 'timeout' }), timeoutMs);
      return { success: true, started: true };
    },
    cancel(reason) {
      if (!state.active) return { success: true, canceled: false };
      setResult({ success: false, error: reason || 'cancelled' });
      return { success: true, canceled: true };
    },
    consumeResult() {
      const result = state.result;
      state.result = null;
      return result;
    },
    cleanup,
  };
  return { success: true, installed: true };
})()
`;

export function elementPickInstallExpression(): string {
  return ELEMENT_PICK_OVERLAY_SOURCE;
}
