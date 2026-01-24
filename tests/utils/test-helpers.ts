/// <reference types="jest" />
/**
 * Test Helper Utilities
 */

import { MCPResult } from '../../src/types/mcp';

/**
 * Extracts text content from an MCP result
 */
export function getResultText(result: MCPResult): string {
  if (!result.content || result.content.length === 0) {
    return '';
  }

  const textContent = result.content.find((c) => c.type === 'text');
  return textContent ? (textContent as { type: 'text'; text: string }).text : '';
}

/**
 * Extracts image content from an MCP result
 */
export function getResultImage(result: MCPResult): { data: string; mimeType: string } | null {
  if (!result.content || result.content.length === 0) {
    return null;
  }

  const imageContent = result.content.find((c) => c.type === 'image');
  if (!imageContent) return null;

  return {
    data: (imageContent as { data: string }).data,
    mimeType: (imageContent as { mimeType: string }).mimeType,
  };
}

/**
 * Checks if result is an error
 */
export function isErrorResult(result: MCPResult): boolean {
  return result.isError === true;
}

/**
 * Parses JSON from result text
 */
export function parseResultJSON<T = unknown>(result: MCPResult): T {
  const text = getResultText(result);
  return JSON.parse(text) as T;
}

/**
 * Creates a delay for async testing
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs a function multiple times concurrently
 */
export async function runConcurrently<T>(
  fn: (index: number) => Promise<T>,
  count: number
): Promise<T[]> {
  const promises = Array.from({ length: count }, (_, i) => fn(i));
  return Promise.all(promises);
}

/**
 * Measures execution time of an async function
 */
export async function measureTime<T>(fn: () => Promise<T>): Promise<{ result: T; durationMs: number }> {
  const start = Date.now();
  const result = await fn();
  const durationMs = Date.now() - start;
  return { result, durationMs };
}

/**
 * Creates a mock MCP request
 */
export function createMCPRequest(
  method: string,
  params?: Record<string, unknown>,
  id: number = 1
) {
  return {
    jsonrpc: '2.0' as const,
    id,
    method,
    params,
  };
}

/**
 * Creates a tools/call request
 */
export function createToolCallRequest(
  toolName: string,
  args: Record<string, unknown>,
  sessionId?: string,
  id: number = 1
) {
  return createMCPRequest(
    'tools/call',
    {
      name: toolName,
      arguments: args,
      sessionId,
    },
    id
  );
}

/**
 * Validates that an object has required properties
 */
export function hasProperties<T extends Record<string, unknown>>(
  obj: unknown,
  properties: (keyof T)[]
): obj is T {
  if (typeof obj !== 'object' || obj === null) {
    return false;
  }
  return properties.every((prop) => prop in obj);
}

/**
 * Generates a random session ID for testing
 */
export function generateTestSessionId(): string {
  return `test-session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Generates a random target ID for testing
 */
export function generateTestTargetId(): string {
  return `test-target-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * URL validation patterns for testing
 */
export const urlPatterns = {
  valid: [
    'https://example.com',
    'http://localhost:3000',
    'https://sub.domain.example.com/path?query=value',
    'https://example.com:8080',
    'https://example.com/path/to/page#section',
  ],
  invalid: [
    '',
    'not-a-url',
    'ftp://invalid.protocol',
    '://missing-protocol.com',
    'http://',
  ],
  needsProtocol: [
    'example.com',
    'www.example.com',
    'localhost',
    'localhost:3000',
    'subdomain.example.com/path',
  ],
};

/**
 * Sample accessibility tree for testing
 */
export const sampleAccessibilityTree = {
  nodes: [
    {
      nodeId: 1,
      backendDOMNodeId: 100,
      role: { value: 'document' },
      name: { value: 'Test Page' },
      childIds: [2, 3, 4],
    },
    {
      nodeId: 2,
      backendDOMNodeId: 101,
      role: { value: 'button' },
      name: { value: 'Submit' },
      properties: [{ name: 'focused', value: { value: true } }],
    },
    {
      nodeId: 3,
      backendDOMNodeId: 102,
      role: { value: 'textbox' },
      name: { value: 'Username' },
      value: { value: '' },
    },
    {
      nodeId: 4,
      backendDOMNodeId: 103,
      role: { value: 'link' },
      name: { value: 'Learn more' },
    },
  ],
};

/**
 * Keyboard key normalization map for testing
 */
export const keyNormalizationMap: Record<string, string> = {
  ctrl: 'Control',
  cmd: 'Meta',
  meta: 'Meta',
  alt: 'Alt',
  shift: 'Shift',
  enter: 'Enter',
  tab: 'Tab',
  escape: 'Escape',
  esc: 'Escape',
  backspace: 'Backspace',
  delete: 'Delete',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
};

/**
 * Common CDP response fixtures
 */
export const cdpFixtures = {
  emptyAccessibilityTree: {
    nodes: [],
  },

  simpleAccessibilityTree: sampleAccessibilityTree,

  resolvedNode: {
    object: { objectId: 'mock-object-id-12345' },
  },

  domDescribeNode: (backendNodeId: number = 12345) => ({
    node: { backendNodeId },
  }),
};

/**
 * Export all utilities
 */
export const testUtils = {
  getResultText,
  getResultImage,
  isErrorResult,
  parseResultJSON,
  delay,
  runConcurrently,
  measureTime,
  createMCPRequest,
  createToolCallRequest,
  hasProperties,
  generateTestSessionId,
  generateTestTargetId,
};
