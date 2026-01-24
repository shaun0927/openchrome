/**
 * Worker Tools - MCP tools that work with RemoteSessionManager
 */

import { WorkerMCPServer } from './worker-mcp-server';
import { RemoteSessionManager } from './remote-session-manager';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';

// Get session manager from the server context
let serverInstance: WorkerMCPServer | null = null;

export function setServerInstance(server: WorkerMCPServer): void {
  serverInstance = server;
}

function getSessionManager(): RemoteSessionManager {
  if (!serverInstance) {
    throw new Error('Server instance not set');
  }
  return serverInstance.getSessionManager();
}

// ============= Navigate Tool =============
const navigateDefinition: MCPToolDefinition = {
  name: 'navigate',
  description: 'Navigate to a URL, or go forward/back in browser history.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: { type: 'string', description: 'Tab ID to navigate' },
      url: { type: 'string', description: 'URL to navigate to, or "back"/"forward"' },
    },
    required: ['url', 'tabId'],
  },
};

const navigateHandler: ToolHandler = async (sessionId, args) => {
  const tabId = args.tabId as string;
  const url = args.url as string;
  const sm = getSessionManager();

  try {
    if (url === 'back' || url === 'forward') {
      await sm.evaluate(sessionId, tabId, url === 'back' ? 'history.back()' : 'history.forward()');
      return { content: [{ type: 'text', text: `Navigated ${url}` }] };
    }

    let targetUrl = url;
    if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
      targetUrl = 'https://' + targetUrl;
    }

    await sm.navigate(sessionId, tabId, targetUrl);
    return { content: [{ type: 'text', text: `Navigated to ${targetUrl}` }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
  }
};

// ============= Tabs Context Tool =============
const tabsContextDefinition: MCPToolDefinition = {
  name: 'tabs_context_mcp',
  description: 'Get context information about available tabs',
  inputSchema: {
    type: 'object',
    properties: {
      createIfEmpty: { type: 'boolean', description: 'Create a new tab if none exist' },
    },
  },
};

const tabsContextHandler: ToolHandler = async (sessionId, args) => {
  const createIfEmpty = args.createIfEmpty as boolean;
  const sm = getSessionManager();

  try {
    let targets = await sm.listTargets(sessionId) as Array<{ targetId: string; url: string; title: string }>;

    if (targets.length === 0 && createIfEmpty) {
      const newTarget = await sm.createTarget(sessionId);
      targets = [newTarget];
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          sessionId,
          tabs: targets.map(t => ({ id: t.targetId, url: t.url, title: t.title })),
        }, null, 2),
      }],
    };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
  }
};

// ============= Tabs Create Tool =============
const tabsCreateDefinition: MCPToolDefinition = {
  name: 'tabs_create_mcp',
  description: 'Create a new tab',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Optional URL to navigate to' },
    },
  },
};

const tabsCreateHandler: ToolHandler = async (sessionId, args) => {
  const url = args.url as string | undefined;
  const sm = getSessionManager();

  try {
    const target = await sm.createTarget(sessionId, url);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ id: target.targetId, url: target.url, title: target.title }, null, 2),
      }],
    };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
  }
};

// ============= Computer Tool =============
const computerDefinition: MCPToolDefinition = {
  name: 'computer',
  description: 'Screenshots, mouse/keyboard, scrolling',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: { type: 'string', description: 'Tab ID' },
      action: {
        type: 'string',
        enum: ['screenshot', 'left_click', 'right_click', 'double_click', 'type', 'key', 'scroll', 'wait'],
      },
      coordinate: { type: 'array', items: { type: 'number' }, description: '[x, y] for click/scroll' },
      text: { type: 'string', description: 'Text to type or key to press' },
      scroll_direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
      scroll_amount: { type: 'number', minimum: 1, maximum: 10 },
      duration: { type: 'number', minimum: 0, maximum: 30 },
    },
    required: ['tabId', 'action'],
  },
};

const computerHandler: ToolHandler = async (sessionId, args) => {
  const tabId = args.tabId as string;
  const action = args.action as string;
  const sm = getSessionManager();

  try {
    switch (action) {
      case 'screenshot': {
        const base64 = await sm.screenshot(sessionId, tabId, { format: 'png' });
        return { content: [{ type: 'image', data: base64, mimeType: 'image/png' }] };
      }

      case 'left_click':
      case 'right_click':
      case 'double_click': {
        const coord = args.coordinate as [number, number];
        if (!coord) return { content: [{ type: 'text', text: 'coordinate required' }], isError: true };
        await sm.click(sessionId, tabId, coord[0], coord[1]);
        return { content: [{ type: 'text', text: `Clicked at (${coord[0]}, ${coord[1]})` }] };
      }

      case 'type': {
        const text = args.text as string;
        if (!text) return { content: [{ type: 'text', text: 'text required' }], isError: true };
        await sm.type(sessionId, tabId, text);
        return { content: [{ type: 'text', text: `Typed: ${text}` }] };
      }

      case 'key': {
        const key = args.text as string;
        if (!key) return { content: [{ type: 'text', text: 'key required' }], isError: true };
        await sm.evaluate(sessionId, tabId, `
          document.dispatchEvent(new KeyboardEvent('keydown', { key: '${key}' }));
          document.dispatchEvent(new KeyboardEvent('keyup', { key: '${key}' }));
        `);
        return { content: [{ type: 'text', text: `Pressed: ${key}` }] };
      }

      case 'scroll': {
        const dir = args.scroll_direction as string;
        const amount = (args.scroll_amount as number) || 3;
        const coord = args.coordinate as [number, number] || [0, 0];
        await sm.scroll(sessionId, tabId, coord[0], coord[1], dir, amount);
        return { content: [{ type: 'text', text: `Scrolled ${dir} by ${amount}` }] };
      }

      case 'wait': {
        const duration = (args.duration as number) || 1;
        await new Promise(r => setTimeout(r, duration * 1000));
        return { content: [{ type: 'text', text: `Waited ${duration}s` }] };
      }

      default:
        return { content: [{ type: 'text', text: `Unknown action: ${action}` }], isError: true };
    }
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
  }
};

// ============= Read Page Tool =============
const readPageDefinition: MCPToolDefinition = {
  name: 'read_page',
  description: 'Get accessibility tree of the page',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: { type: 'string', description: 'Tab ID' },
      depth: { type: 'number', description: 'Max depth (default: 15)' },
      filter: { type: 'string', enum: ['interactive', 'all'] },
    },
    required: ['tabId'],
  },
};

const readPageHandler: ToolHandler = async (sessionId, args) => {
  const tabId = args.tabId as string;
  const sm = getSessionManager();

  try {
    const tree = await sm.getAccessibilityTree(sessionId, tabId) as { nodes: unknown[] };
    // Simple formatting
    const text = JSON.stringify(tree, null, 2).slice(0, 50000);
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
  }
};

// ============= Find Tool =============
const findDefinition: MCPToolDefinition = {
  name: 'find',
  description: 'Find elements by natural language description',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: { type: 'string', description: 'Tab ID' },
      query: { type: 'string', description: 'What to find' },
    },
    required: ['tabId', 'query'],
  },
};

const findHandler: ToolHandler = async (sessionId, args) => {
  const tabId = args.tabId as string;
  const query = args.query as string;
  const sm = getSessionManager();

  try {
    // Use JavaScript to find elements
    const result = await sm.evaluate(sessionId, tabId, `
      (function() {
        const query = "${query.replace(/"/g, '\\"')}".toLowerCase();
        const matches = [];
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
        let node;
        while ((node = walker.nextNode()) && matches.length < 20) {
          const text = (node.textContent || '').toLowerCase();
          const ariaLabel = (node.getAttribute('aria-label') || '').toLowerCase();
          const role = node.getAttribute('role') || node.tagName.toLowerCase();
          if (text.includes(query) || ariaLabel.includes(query) || role.includes(query)) {
            const rect = node.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              matches.push({
                tag: node.tagName,
                text: (node.textContent || '').slice(0, 50),
                x: Math.round(rect.x + rect.width/2),
                y: Math.round(rect.y + rect.height/2)
              });
            }
          }
        }
        return matches;
      })()
    `);

    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
  }
};

// ============= Form Input Tool =============
const formInputDefinition: MCPToolDefinition = {
  name: 'form_input',
  description: 'Set form values',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: { type: 'string', description: 'Tab ID' },
      ref: { type: 'string', description: 'Element ref ID' },
      value: { type: 'string', description: 'Value to set' },
    },
    required: ['tabId', 'ref', 'value'],
  },
};

const formInputHandler: ToolHandler = async (sessionId, args) => {
  const tabId = args.tabId as string;
  const value = args.value as string;
  const sm = getSessionManager();

  try {
    // For now, use a simple approach with focused element
    await sm.evaluate(sessionId, tabId, `
      const el = document.activeElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
        el.value = "${value.replace(/"/g, '\\"')}";
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    `);
    return { content: [{ type: 'text', text: `Set value: ${value}` }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
  }
};

// ============= JavaScript Tool =============
const javascriptDefinition: MCPToolDefinition = {
  name: 'javascript_tool',
  description: 'Execute JavaScript in page context',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: { type: 'string', description: 'Tab ID' },
      text: { type: 'string', description: 'JavaScript code' },
    },
    required: ['tabId', 'text'],
  },
};

const javascriptHandler: ToolHandler = async (sessionId, args) => {
  const tabId = args.tabId as string;
  const code = args.text as string;
  const sm = getSessionManager();

  try {
    const result = await sm.evaluate(sessionId, tabId, code);
    const output = result === undefined ? 'undefined' : JSON.stringify(result, null, 2);
    return { content: [{ type: 'text', text: output }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
  }
};

// ============= Register All Tools =============
export function registerWorkerTools(server: WorkerMCPServer): void {
  setServerInstance(server);

  server.registerTool('navigate', navigateHandler, navigateDefinition);
  server.registerTool('tabs_context_mcp', tabsContextHandler, tabsContextDefinition);
  server.registerTool('tabs_create_mcp', tabsCreateHandler, tabsCreateDefinition);
  server.registerTool('computer', computerHandler, computerDefinition);
  server.registerTool('read_page', readPageHandler, readPageDefinition);
  server.registerTool('find', findHandler, findDefinition);
  server.registerTool('form_input', formInputHandler, formInputDefinition);
  server.registerTool('javascript_tool', javascriptHandler, javascriptDefinition);

  console.error('[WorkerTools] Registered 8 tools');
}
