export const REACT_DEVTOOLS_SHIM_ID = 'pilot:react-devtools-shim';

export const REACT_DEVTOOLS_SHIM_SOURCE = `(() => {
  if (window.__OPENCHROME_REACT_DEVTOOLS_SHIM__) return;
  const roots = [];
  const renderCounts = Object.create(null);
  const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__ || {};
  function nameOf(fiber) {
    const t = fiber && fiber.type;
    return (t && (t.displayName || t.name)) || (fiber && fiber.elementType && (fiber.elementType.displayName || fiber.elementType.name)) || 'Anonymous';
  }
  function rememberRoot(root) {
    if (root && roots.indexOf(root) === -1) roots.push(root);
  }
  function countFiber(fiber) {
    const name = nameOf(fiber);
    renderCounts[name] = (renderCounts[name] || 0) + 1;
  }
  hook.supportsFiber = true;
  hook.renderers = hook.renderers || new Map();
  hook._openchromeRoots = roots;
  hook._openchromeRenderCounts = renderCounts;
  hook.inject = hook.inject || function(renderer) {
    const id = hook.renderers.size + 1;
    hook.renderers.set(id, renderer);
    return id;
  };
  hook.onCommitFiberRoot = function(rendererId, root) {
    rememberRoot(root);
    const current = root && root.current;
    if (current) countFiber(current);
  };
  hook.onCommitFiberUnmount = hook.onCommitFiberUnmount || function() {};
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook;
  window.__OPENCHROME_REACT_DEVTOOLS_SHIM__ = { roots, renderCounts, installedAt: Date.now() };
})();`;

export function assertShimBudget(maxBytes = 8192): void {
  const bytes = Buffer.byteLength(REACT_DEVTOOLS_SHIM_SOURCE, 'utf8');
  if (bytes > maxBytes) {
    throw new Error(`React DevTools shim exceeds budget: ${bytes} > ${maxBytes}`);
  }
}
