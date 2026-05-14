import { captureReplayStep, type ReplayArtifactStep, type ReplayStepKind } from '../../core/skill-memory';
import { getTargetId } from '../../utils/puppeteer-helpers';

interface ElementCaptureInput {
  cdpClient: { send: <T = unknown>(page: any, method: string, params?: Record<string, unknown>) => Promise<T> };
  page: any;
  objectId: string;
  kind: ReplayStepKind;
  args?: Record<string, unknown>;
}

interface BackendNodeCaptureInput {
  cdpClient: { send: <T = unknown>(page: any, method: string, params?: Record<string, unknown>) => Promise<T> };
  page: any;
  backendNodeId: number;
  kind: ReplayStepKind;
  args?: Record<string, unknown>;
}

interface NavigationCaptureInput {
  page: any;
  url: string;
}

/**
 * Default-off gate for #988 replay-artifact capture hooks. Only literal true
 * enables side effects so omitted / false remains byte-identical to the old
 * response path.
 */
export function shouldCaptureReplayArtifact(value: unknown): boolean {
  return value === true;
}

/**
 * Capture a navigation replay step for the page's current target.
 */
export function captureNavigationReplayStep(input: NavigationCaptureInput): void {
  try {
    if (typeof input.url !== 'string' || input.url.length === 0) return;
    const target = (input.page as { target?: () => unknown }).target?.();
    captureReplayStep(target ? getTargetId(target as never) : '', {
      kind: 'navigate',
      selectors: [],
      args: { url: input.url },
    });
  } catch {
    // Best-effort recorder hook: never change action tool behaviour.
  }
}

/**
 * Capture a pre-resolved replay step for the page's current target. Use this
 * only when the tool already resolved stable selectors in page context and no
 * backendNodeId/objectId is available (for example coordinate-only submit
 * buttons).
 */
export function capturePageReplayStep(page: any, step: ReplayArtifactStep): void {
  try {
    if (!Array.isArray(step.selectors) || step.selectors.length === 0) return;
    const target = (page as { target?: () => unknown }).target?.();
    captureReplayStep(target ? getTargetId(target as never) : '', step);
  } catch {
    // Best-effort recorder hook: never change action-tool behaviour.
  }
}

/**
 * Capture a replay step for a DOM node addressed by backendNodeId.
 */
export async function captureBackendNodeReplayStep(input: BackendNodeCaptureInput): Promise<void> {
  try {
    const resolved = await input.cdpClient.send<{ object?: { objectId?: string } }>(
      input.page,
      'DOM.resolveNode',
      { backendNodeId: input.backendNodeId },
    );
    const objectId = resolved.object?.objectId;
    if (!objectId) return;
    await captureElementReplayStep({
      cdpClient: input.cdpClient,
      page: input.page,
      objectId,
      kind: input.kind,
      ...(input.args ? { args: input.args } : {}),
    });
  } catch {
    // Best-effort recorder hook: never change action tool behaviour.
  }
}

/**
 * Capture a replay step for a resolved DOM element. Best-effort by design:
 * recorder failures must never affect action-tool success responses.
 */
export async function captureElementReplayStep(input: ElementCaptureInput): Promise<void> {
  try {
    const selectors = await input.cdpClient.send<{ result?: { value?: string[] } }>(
      input.page,
      'Runtime.callFunctionOn',
      {
        objectId: input.objectId,
        functionDeclaration: buildSelectorCaptureFunction(),
        returnByValue: true,
      },
    );
    const cssSelectors = Array.isArray(selectors.result?.value)
      ? selectors.result.value.filter((selector): selector is string => typeof selector === 'string' && selector.length > 0).slice(0, 3)
      : [];
    if (cssSelectors.length === 0) return;

    const step: ReplayArtifactStep = {
      kind: input.kind,
      selectors: cssSelectors.map((value) => ({ type: 'css' as const, value })),
      ...(input.args ? { args: input.args } : {}),
    };
    const target = (input.page as { target?: () => unknown }).target?.();
    captureReplayStep(target ? getTargetId(target as never) : '', step);
  } catch {
    // Best-effort recorder hook: never change action tool behaviour.
  }
}

function buildSelectorCaptureFunction(): string {
  return String.raw`
    function() {
      const el = this;
      const out = [];
      const esc = (value) => {
        if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(String(value));
        return String(value).replace(/[^a-zA-Z0-9_-]/g, (ch) => '\\' + ch);
      };
      const add = (selector) => {
        if (!selector || out.includes(selector)) return;
        try {
          if (document.querySelector(selector) === el) out.push(selector);
        } catch {}
      };
      if (el.id) add('#' + esc(el.id));
      const tag = String(el.tagName || '').toLowerCase();
      for (const attr of ['name', 'aria-label', 'placeholder', 'data-testid', 'data-test', 'data-cy']) {
        const value = el.getAttribute && el.getAttribute(attr);
        if (tag && value) add(tag + '[' + attr + '="' + String(value).replace(/"/g, '\\"') + '"]');
      }
      if (tag) {
        const parts = [];
        let node = el;
        while (node && node.nodeType === 1 && parts.length < 4) {
          const nodeTag = String(node.tagName || '').toLowerCase();
          if (!nodeTag) break;
          if (node.id) {
            parts.unshift(nodeTag + '#' + esc(node.id));
            break;
          }
          let index = 1;
          let prev = node.previousElementSibling;
          while (prev) {
            if (prev.tagName === node.tagName) index++;
            prev = prev.previousElementSibling;
          }
          parts.unshift(nodeTag + ':nth-of-type(' + index + ')');
          node = node.parentElement;
        }
        add(parts.join(' > '));
      }
      return out.slice(0, 3);
    }
  `;
}
