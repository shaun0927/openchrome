/**
 * Read Page Tool - Get accessibility tree representation
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getSessionManager } from '../session-manager';
import { getRefIdManager } from '../utils/ref-id-manager';

const definition: MCPToolDefinition = {
  name: 'read_page',
  description:
    'Get an accessibility tree representation of elements on the page. Returns element references that can be used with other tools.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'string',
        description: 'Tab ID to read from',
      },
      depth: {
        type: 'number',
        description: 'Maximum depth of the tree to traverse (default: 8 for "all", 5 for "interactive")',
      },
      filter: {
        type: 'string',
        enum: ['interactive', 'all'],
        description: 'Filter elements: "interactive" for buttons/links/inputs only',
      },
      ref_id: {
        type: 'string',
        description: 'Reference ID of a parent element to read from (uses faster partial tree fetch)',
      },
    },
    required: ['tabId'],
  },
};

interface AXNode {
  nodeId: number;
  backendDOMNodeId?: number;
  role?: { value: string };
  name?: { value: string };
  value?: { value: string };
  childIds?: number[];
  properties?: Array<{ name: string; value: { value: unknown } }>;
}

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>
): Promise<MCPResult> => {
  const tabId = args.tabId as string;
  const filter = (args.filter as string) || 'all';
  const refIdParam = args.ref_id as string | undefined;

  const sessionManager = getSessionManager();
  const refIdManager = getRefIdManager();

  if (!tabId) {
    return {
      content: [{ type: 'text', text: 'Error: tabId is required' }],
      isError: true,
    };
  }

  try {
    const page = await sessionManager.getPage(sessionId, tabId, undefined, 'read_page');
    if (!page) {
      return {
        content: [{ type: 'text', text: `Error: Tab ${tabId} not found` }],
        isError: true,
      };
    }

    const cdpClient = sessionManager.getCDPClient();

    // Determine depth: explicit arg > filter-based default
    // Reduce default from 15→8 for "all" (15 is excessively deep and very slow on complex pages)
    const defaultDepth = filter === 'interactive' ? 5 : 8;
    const maxDepth = (args.depth as number) || defaultDepth;
    const fetchDepth = filter === 'interactive' ? Math.min(maxDepth, 5) : maxDepth;

    let nodes: AXNode[];

    // When ref_id is provided, use getPartialAXTree to scope the fetch to a subtree.
    // This is significantly faster than getFullAXTree on complex pages (e.g. Twitter).
    if (refIdParam) {
      const backendDOMNodeId = refIdManager.getBackendDOMNodeId(sessionId, tabId, refIdParam);
      if (!backendDOMNodeId) {
        return {
          content: [{ type: 'text', text: `Error: ref_id "${refIdParam}" not found or expired` }],
          isError: true,
        };
      }

      // Resolve backendDOMNodeId → DOM nodeId via DOM.describeNode
      let domNodeId: number | undefined;
      try {
        const { node: domNode } = await cdpClient.send<{ node: { nodeId: number } }>(
          page,
          'DOM.describeNode',
          { backendNodeId: backendDOMNodeId }
        );
        domNodeId = domNode.nodeId;
      } catch {
        // DOM.describeNode may return nodeId=0 for non-document nodes if DOM hasn't been enabled.
        // Fall back to getFullAXTree in that case.
      }

      if (domNodeId && domNodeId !== 0) {
        const result = await cdpClient.send<{ nodes: AXNode[] }>(
          page,
          'Accessibility.getPartialAXTree',
          { nodeId: domNodeId, fetchRelatives: true }
        );
        nodes = result.nodes;
      } else {
        // Fallback: full tree
        const result = await cdpClient.send<{ nodes: AXNode[] }>(
          page,
          'Accessibility.getFullAXTree',
          { depth: fetchDepth }
        );
        nodes = result.nodes;
      }
    } else {
      const result = await cdpClient.send<{ nodes: AXNode[] }>(
        page,
        'Accessibility.getFullAXTree',
        { depth: fetchDepth }
      );
      nodes = result.nodes;
    }

    // Clear previous refs for this target
    refIdManager.clearTargetRefs(sessionId, tabId);

    // Build the tree structure
    const nodeMap = new Map<number, AXNode>();
    for (const node of nodes) {
      nodeMap.set(node.nodeId, node);
    }

    // Interactive roles
    const interactiveRoles = new Set([
      'button',
      'link',
      'textbox',
      'checkbox',
      'radio',
      'combobox',
      'listbox',
      'menu',
      'menuitem',
      'menuitemcheckbox',
      'menuitemradio',
      'option',
      'searchbox',
      'slider',
      'spinbutton',
      'switch',
      'tab',
      'treeitem',
    ]);

    // Format nodes
    const lines: string[] = [];
    let charCount = 0;
    const MAX_OUTPUT = 50000;

    function formatNode(node: AXNode, indent: number): void {
      if (charCount > MAX_OUTPUT) return;

      const role = node.role?.value || 'unknown';
      const name = node.name?.value || '';
      const value = node.value?.value || '';

      // Apply filter
      if (filter === 'interactive' && !interactiveRoles.has(role)) {
        // Still process children
        if (node.childIds) {
          for (const childId of node.childIds) {
            const child = nodeMap.get(childId);
            if (child) formatNode(child, indent);
          }
        }
        return;
      }

      // Generate ref ID if element has a backend DOM node
      let refId = '';
      if (node.backendDOMNodeId) {
        refId = refIdManager.generateRef(
          sessionId,
          tabId,
          node.backendDOMNodeId,
          role,
          name
        );
      }

      // Build line
      const indentStr = '  '.repeat(indent);
      let line = `${indentStr}[${refId || 'no-ref'}] ${role}`;
      if (name) line += `: "${name}"`;
      if (value) line += ` = "${value}"`;

      // Add relevant properties
      if (node.properties) {
        const props: string[] = [];
        for (const prop of node.properties) {
          if (['focused', 'disabled', 'checked', 'selected', 'expanded'].includes(prop.name)) {
            if (prop.value.value === true) {
              props.push(prop.name);
            }
          }
        }
        if (props.length > 0) {
          line += ` (${props.join(', ')})`;
        }
      }

      lines.push(line);
      charCount += line.length + 1;

      // Process children
      if (node.childIds && indent < maxDepth) {
        for (const childId of node.childIds) {
          const child = nodeMap.get(childId);
          if (child) formatNode(child, indent + 1);
        }
      }
    }

    // Start from root nodes — O(n) Set-based detection (replaces O(n²) nested .some())
    const childIdSet = new Set<number>();
    for (const node of nodes) {
      if (node.childIds) {
        for (const childId of node.childIds) {
          childIdSet.add(childId);
        }
      }
    }
    const rootNodes = nodes.filter((n) => !childIdSet.has(n.nodeId));

    for (const root of rootNodes) {
      formatNode(root, 0);
    }

    const output = lines.join('\n');

    if (charCount > MAX_OUTPUT) {
      return {
        content: [
          {
            type: 'text',
            text:
              output +
              '\n\n[Output truncated. Use smaller depth or ref_id to focus on specific element.]',
          },
        ],
      };
    }

    return {
      content: [{ type: 'text', text: output }],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Read page error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
};

export function registerReadPageTool(server: MCPServer): void {
  server.registerTool('read_page', handler, definition);
}
