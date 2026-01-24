/**
 * Read page tool for MCP - Returns accessibility tree representation
 */

import type { MCPResult, MCPToolDefinition } from '../types/mcp';
import { SessionManager } from '../session-manager';

interface AXNode {
  nodeId: string;
  role: { value: string };
  name?: { value: string };
  description?: { value: string };
  value?: { value: string };
  backendDOMNodeId?: number;
  childIds?: string[];
  properties?: Array<{ name: string; value: { value: unknown } }>;
}

interface AccessibilityNode {
  ref: string;
  role: string;
  name?: string;
  value?: string;
  description?: string;
  children?: AccessibilityNode[];
  interactive?: boolean;
}

export function createReadPageTool(sessionManager: SessionManager) {
  const MAX_OUTPUT_LENGTH = 50000;

  async function getAccessibilityTree(
    sessionId: string,
    tabId: number,
    options: {
      depth?: number;
      refId?: string;
      filter?: 'interactive' | 'all';
    }
  ): Promise<string> {
    const { depth = 15, refId, filter = 'all' } = options;

    // Get the full accessibility tree
    const result = await sessionManager.executeCDP<{ nodes: AXNode[] }>(
      sessionId,
      tabId,
      'Accessibility.getFullAXTree',
      { depth }
    );

    if (!result.nodes || result.nodes.length === 0) {
      return 'No accessibility tree available';
    }

    // Build a map for quick lookup
    const nodeMap = new Map<string, AXNode>();
    for (const node of result.nodes) {
      nodeMap.set(node.nodeId, node);
    }

    // Find root or specified node
    let rootNode: AXNode | undefined;
    if (refId) {
      rootNode = result.nodes.find((n) => n.nodeId === refId);
      if (!rootNode) {
        throw new Error(`Node with ref_id ${refId} not found`);
      }
    } else {
      rootNode = result.nodes[0];
    }

    // Convert to our format
    let refCounter = 1;
    const refMap = new Map<string, string>();

    function convertNode(node: AXNode, currentDepth: number): AccessibilityNode | null {
      if (currentDepth > depth) return null;

      const role = node.role?.value || 'unknown';
      const name = node.name?.value;
      const value = node.value?.value;
      const description = node.description?.value;

      // Check if interactive
      const interactiveRoles = [
        'button',
        'link',
        'textbox',
        'checkbox',
        'radio',
        'combobox',
        'listbox',
        'option',
        'menuitem',
        'tab',
        'slider',
        'spinbutton',
        'switch',
        'searchbox',
        'textfield',
      ];
      const interactive = interactiveRoles.includes(role.toLowerCase());

      // Filter if needed
      if (filter === 'interactive' && !interactive) {
        // Still process children to find interactive elements
        if (node.childIds) {
          const interactiveChildren: AccessibilityNode[] = [];
          for (const childId of node.childIds) {
            const childNode = nodeMap.get(childId);
            if (childNode) {
              const converted = convertNode(childNode, currentDepth + 1);
              if (converted) {
                interactiveChildren.push(converted);
              }
            }
          }
          if (interactiveChildren.length > 0) {
            return {
              ref: '',
              role: 'group',
              children: interactiveChildren,
            };
          }
        }
        return null;
      }

      // Generate ref ID
      const ref = `ref_${refCounter++}`;
      refMap.set(node.nodeId, ref);

      const result: AccessibilityNode = {
        ref,
        role,
      };

      if (name) result.name = name;
      if (value) result.value = value;
      if (description) result.description = description;
      if (interactive) result.interactive = true;

      // Process children
      if (node.childIds && node.childIds.length > 0) {
        const children: AccessibilityNode[] = [];
        for (const childId of node.childIds) {
          const childNode = nodeMap.get(childId);
          if (childNode) {
            const converted = convertNode(childNode, currentDepth + 1);
            if (converted) {
              children.push(converted);
            }
          }
        }
        if (children.length > 0) {
          result.children = children;
        }
      }

      return result;
    }

    const tree = convertNode(rootNode, 0);
    if (!tree) {
      return 'No matching elements found';
    }

    // Format as readable text
    function formatTree(node: AccessibilityNode, indent = 0): string {
      const prefix = '  '.repeat(indent);
      let line = `${prefix}[${node.ref}] ${node.role}`;
      if (node.name) line += `: "${node.name}"`;
      if (node.value) line += ` = "${node.value}"`;
      if (node.interactive) line += ' (interactive)';
      line += '\n';

      if (node.children) {
        for (const child of node.children) {
          line += formatTree(child, indent + 1);
        }
      }

      return line;
    }

    let output = formatTree(tree);

    // Truncate if too long
    if (output.length > MAX_OUTPUT_LENGTH) {
      output =
        output.slice(0, MAX_OUTPUT_LENGTH) +
        `\n... (output truncated, use smaller depth or ref_id to focus on specific element)`;
    }

    return output;
  }

  return {
    handler: async (sessionId: string, params: Record<string, unknown>): Promise<MCPResult> => {
      const tabId = params.tabId as number;
      const depth = (params.depth as number) ?? 15;
      const refId = params.ref_id as string | undefined;
      const filter = params.filter as 'interactive' | 'all' | undefined;

      if (!sessionId) {
        return {
          content: [{ type: 'text', text: 'Error: sessionId is required' }],
          isError: true,
        };
      }

      if (!tabId) {
        return {
          content: [{ type: 'text', text: 'Error: tabId is required' }],
          isError: true,
        };
      }

      // Validate tab ownership
      if (!sessionManager.validateTabOwnership(sessionId, tabId)) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: Tab ${tabId} does not belong to session ${sessionId}`,
            },
          ],
          isError: true,
        };
      }

      try {
        const tree = await getAccessibilityTree(sessionId, tabId, {
          depth,
          refId,
          filter,
        });

        return {
          content: [{ type: 'text', text: tree }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text', text: `Error reading page: ${message}` }],
          isError: true,
        };
      }
    },

    definition: {
      name: 'read_page',
      description:
        'Get an accessibility tree representation of elements on the page. By default returns all elements. Output is limited to 50000 characters.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          sessionId: {
            type: 'string',
            description: 'Session ID for isolation',
          },
          tabId: {
            type: 'number',
            description: 'Tab ID to read from',
          },
          depth: {
            type: 'number',
            description: 'Maximum depth of the tree to traverse (default: 15)',
          },
          ref_id: {
            type: 'string',
            description: 'Reference ID of a parent element to read. Will return the specified element and all its children.',
          },
          filter: {
            type: 'string',
            enum: ['interactive', 'all'],
            description: 'Filter elements: "interactive" for buttons/links/inputs only, "all" for all elements (default)',
          },
        },
        required: ['sessionId', 'tabId'],
      },
    } as MCPToolDefinition,
  };
}
