/**
 * Read Page Tool - Get accessibility tree representation
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getSessionManager } from '../session-manager';
import { getRefIdManager } from '../utils/ref-id-manager';
import { serializeDOM } from '../dom';

const definition: MCPToolDefinition = {
  name: 'read_page',
  description:
    'Get page content. Default mode "ax" returns accessibility tree with ref_N identifiers. Mode "dom" returns compact DOM with backendNodeId identifiers (~5-10x fewer tokens).',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'string',
        description: 'Tab ID to read from',
      },
      depth: {
        type: 'number',
        description: 'Maximum depth of the tree to traverse (default: 15)',
      },
      filter: {
        type: 'string',
        enum: ['interactive', 'all'],
        description: 'Filter elements: "interactive" for buttons/links/inputs only',
      },
      ref_id: {
        type: 'string',
        description: 'Reference ID of a parent element to read from',
      },
      mode: {
        type: 'string',
        enum: ['ax', 'dom'],
        description: 'Output mode: "ax" for accessibility tree (default), "dom" for compact DOM representation with ~5-10x fewer tokens',
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
  const maxDepth = (args.depth as number) || 15;
  const filter = (args.filter as string) || 'all';

  const sessionManager = getSessionManager();
  const refIdManager = getRefIdManager();

  if (!tabId) {
    return {
      content: [{ type: 'text', text: 'Error: tabId is required' }],
      isError: true,
    };
  }

  try {
    const page = await sessionManager.getPage(sessionId, tabId);
    if (!page) {
      return {
        content: [{ type: 'text', text: `Error: Tab ${tabId} not found` }],
        isError: true,
      };
    }

    const cdpClient = sessionManager.getCDPClient();

    // DOM serialization mode
    const mode = (args.mode as string) || 'ax';
    if (mode === 'dom') {
      const depth = args.depth as number | undefined;
      const result = await serializeDOM(page, cdpClient, {
        maxDepth: depth ?? -1,
        filter: filter,
        interactiveOnly: filter === 'interactive',
      });

      return {
        content: [{ type: 'text', text: result.content }],
      };
    }

    // Get the accessibility tree
    const { nodes } = await cdpClient.send<{ nodes: AXNode[] }>(
      page,
      'Accessibility.getFullAXTree',
      { depth: maxDepth }
    );

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

    // Start from root nodes
    const rootNodes = nodes.filter(
      (n) => !nodes.some((other) => other.childIds?.includes(n.nodeId))
    );
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
