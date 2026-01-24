/**
 * Service Worker - Main background script for Claude Chrome Parallel
 *
 * This is the entry point for the extension. It:
 * 1. Initializes the session manager and MCP handler
 * 2. Sets up native messaging for CLI communication
 * 3. Listens for tab/group events
 * 4. Handles MCP requests from Claude Code sessions
 */

import { TabGroupManager } from './tab-group-manager';
import { CDPConnectionPool } from './cdp-pool';
import { RequestQueueManager } from './request-queue';
import { SessionManager } from './session-manager';
import { MCPHandler } from './mcp-handler';
import { registerAllTools } from './tools';
import type { MCPRequest, MCPResponse } from './types/mcp';

// Constants
const NATIVE_HOST_NAME = 'com.anthropic.claude_chrome_parallel';
const SESSION_CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes
const SESSION_MAX_INACTIVE_AGE = 30 * 60 * 1000; // 30 minutes

// Global instances
let tabGroupManager: TabGroupManager;
let cdpPool: CDPConnectionPool;
let queueManager: RequestQueueManager;
let sessionManager: SessionManager;
let mcpHandler: MCPHandler;
let nativePort: chrome.runtime.Port | null = null;

/**
 * Initialize all managers
 */
function initialize(): void {
  console.log('[Claude Chrome Parallel] Initializing...');

  tabGroupManager = new TabGroupManager();
  cdpPool = new CDPConnectionPool();
  queueManager = new RequestQueueManager();
  sessionManager = new SessionManager(tabGroupManager, cdpPool, queueManager);
  mcpHandler = new MCPHandler(sessionManager);

  // Register all tools
  registerAllTools(mcpHandler, sessionManager);

  console.log('[Claude Chrome Parallel] Registered tools:', mcpHandler.getToolNames());

  // Set up periodic cleanup
  setInterval(() => {
    sessionManager.cleanupInactiveSessions(SESSION_MAX_INACTIVE_AGE).then((deleted) => {
      if (deleted.length > 0) {
        console.log('[Claude Chrome Parallel] Cleaned up inactive sessions:', deleted);
      }
    });
  }, SESSION_CLEANUP_INTERVAL);

  console.log('[Claude Chrome Parallel] Initialized successfully');
}

/**
 * Handle incoming MCP request
 */
async function handleMCPRequest(request: MCPRequest): Promise<MCPResponse> {
  try {
    return await mcpHandler.handleRequest(request);
  } catch (error) {
    console.error('[Claude Chrome Parallel] MCP request error:', error);
    return {
      jsonrpc: '2.0',
      id: request.id,
      error: {
        code: -32603,
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/**
 * Set up native messaging
 */
function setupNativeMessaging(): void {
  // Listen for connections from native host
  chrome.runtime.onConnectExternal.addListener((port) => {
    console.log('[Claude Chrome Parallel] External connection from:', port.name);

    port.onMessage.addListener(async (message: MCPRequest) => {
      const response = await handleMCPRequest(message);
      port.postMessage(response);
    });

    port.onDisconnect.addListener(() => {
      console.log('[Claude Chrome Parallel] External port disconnected');
    });
  });

  // Also listen for internal connections (from content scripts, popup)
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name === 'mcp') {
      console.log('[Claude Chrome Parallel] MCP port connected');

      port.onMessage.addListener(async (message: MCPRequest) => {
        const response = await handleMCPRequest(message);
        port.postMessage(response);
      });

      port.onDisconnect.addListener(() => {
        console.log('[Claude Chrome Parallel] MCP port disconnected');
      });
    }
  });

  // Native messaging via runtime.sendNativeMessage (for direct calls)
  // This requires the native messaging host to be set up
}

/**
 * Connect to native messaging host
 */
function connectNativeHost(): void {
  try {
    nativePort = chrome.runtime.connectNative(NATIVE_HOST_NAME);

    nativePort.onMessage.addListener(async (message: MCPRequest) => {
      console.log('[Claude Chrome Parallel] Native message received:', message.method);
      const response = await handleMCPRequest(message);
      nativePort?.postMessage(response);
    });

    nativePort.onDisconnect.addListener(() => {
      console.log(
        '[Claude Chrome Parallel] Native port disconnected:',
        chrome.runtime.lastError?.message
      );
      nativePort = null;

      // Attempt to reconnect after a delay
      setTimeout(connectNativeHost, 5000);
    });

    console.log('[Claude Chrome Parallel] Connected to native host');
  } catch (error) {
    console.log('[Claude Chrome Parallel] Native host not available:', error);
    // Native host not installed, that's OK - we can still work via message passing
  }
}

/**
 * Set up Chrome event listeners
 */
function setupEventListeners(): void {
  // Tab removed
  chrome.tabs.onRemoved.addListener((tabId) => {
    sessionManager.onTabRemoved(tabId);
  });

  // Tab group removed (when all tabs are ungrouped or closed)
  // Note: There's no direct event for this, but we can detect it
  // when tabs are removed or ungrouped

  // Debugger detached
  chrome.debugger.onDetach.addListener((target, reason) => {
    cdpPool.onDetach(target, reason);
  });

  // Handle messages from content scripts
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'mcp-request') {
      handleMCPRequest(message.request).then(sendResponse);
      return true; // Will respond asynchronously
    }
  });

  // Handle external messages (from other extensions or web pages if allowed)
  chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
    if (message.type === 'mcp-request') {
      handleMCPRequest(message.request).then(sendResponse);
      return true;
    }
  });
}

/**
 * Extension install/update handler
 */
chrome.runtime.onInstalled.addListener((details) => {
  console.log('[Claude Chrome Parallel] Extension installed/updated:', details.reason);

  if (details.reason === 'install') {
    // First install - could show welcome page
    console.log('[Claude Chrome Parallel] First install - ready to use!');
  } else if (details.reason === 'update') {
    console.log('[Claude Chrome Parallel] Updated from version:', details.previousVersion);
  }
});

/**
 * Extension startup handler
 */
chrome.runtime.onStartup.addListener(() => {
  console.log('[Claude Chrome Parallel] Browser started');
  initialize();
  setupEventListeners();
  setupNativeMessaging();
  connectNativeHost();
});

// Initialize immediately (for when extension is loaded/reloaded)
initialize();
setupEventListeners();
setupNativeMessaging();

// Try to connect to native host (will fail gracefully if not installed)
setTimeout(connectNativeHost, 1000);

// Export for testing
export { sessionManager, mcpHandler, handleMCPRequest };
