/**
 * Request Intercept Tool - Intercept and modify network requests
 */

import { HTTPRequest } from 'puppeteer-core';
import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { TOOL_ANNOTATIONS } from '../types/tool-annotations';
import { getSessionManager } from '../session-manager';
import { getMetricsCollector } from '../metrics/collector';

// --- Bandwidth preset table ---
// Exported so tests can import directly without going through the tool handler.
export type BandwidthPreset = 'optimize-bandwidth' | 'optimize-bandwidth-light';

/**
 * Maps each preset name to the CDP ResourceType strings it blocks.
 * CDP ResourceType values are PascalCase (Image, Media, Font, Stylesheet).
 */
export const PRESET_RESOURCE_TYPES: Record<BandwidthPreset, string[]> = {
  'optimize-bandwidth': ['Image', 'Media', 'Font', 'Stylesheet'],
  'optimize-bandwidth-light': ['Image', 'Media', 'Font'],
};

export const SUPPORTED_PRESETS: BandwidthPreset[] = [
  'optimize-bandwidth',
  'optimize-bandwidth-light',
];

/**
 * Expand a preset name into InterceptRule entries (block rules, one per resource type).
 * Rules use pattern '*' (match any URL) filtered to the resource type.
 */
function presetToRules(preset: BandwidthPreset): InterceptRule[] {
  return PRESET_RESOURCE_TYPES[preset].map((rt) => ({
    id: `preset-${preset}-${rt.toLowerCase()}`,
    pattern: '*',
    resourceTypes: [rt.toLowerCase()], // Puppeteer resourceType() returns lowercase
    action: 'block' as const,
  }));
}

// Read env once at module load — applied per-enable when set.
const ENV_PRESET = (process.env.OPENCHROME_OPTIMIZE_BANDWIDTH ?? '').trim() as BandwidthPreset | '';

// Intercept rule definition
interface InterceptRule {
  id: string;
  pattern: string;
  resourceTypes?: string[];
  action: 'block' | 'modify' | 'log' | 'allow';
  modifyOptions?: {
    headers?: Record<string, string>;
    body?: string;
    status?: number;
  };
}

// Logged request entry
interface RequestLogEntry {
  url: string;
  resourceType: string;
  method: string;
  headers: Record<string, string>;
  timestamp: number;
  matched: boolean;
  ruleId?: string;
}

// Intercept state for each tab
interface InterceptState {
  enabled: boolean;
  rules: InterceptRule[];
  listener: ((request: HTTPRequest) => void) | null;
  loggedRequests: RequestLogEntry[];
  maxLogs: number;
}

// Module-level state storage
const interceptStates: Map<string, InterceptState> = new Map();

// Headers to keep when stripping request/response headers for compression
const KEEP_HEADERS = new Set([
  'content-type',
  'authorization',
  'x-request-id',
  'cache-control',
]);

// Resource types considered static assets (eligible for grouping)
const ASSET_TYPES = new Set(['image', 'font', 'stylesheet', 'media']);

const STATIC_ASSET_RESPONSE_BYTE_ESTIMATES: Record<string, number> = {
  image: 100 * 1024,
  media: 1024 * 1024,
  font: 30 * 1024,
  stylesheet: 20 * 1024,
};

interface AssetGroup {
  domain: string;
  type: string;
  count: number;
  urls: string[];
}

interface CompressedLogs {
  apiLogs: RequestLogEntry[];
  failedLogs: RequestLogEntry[];
  assetGroups: AssetGroup[];
}

/**
 * Strip headers to only keep the whitelist entries.
 */
function stripHeaders(headers: Record<string, string>): Record<string, string> {
  const stripped: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (KEEP_HEADERS.has(key.toLowerCase())) {
      stripped[key] = value;
    }
  }
  return stripped;
}

/**
 * Group static asset requests by domain, keeping API calls and failures individually.
 */
function groupAssetRequests(logs: RequestLogEntry[]): CompressedLogs {
  const apiLogs: RequestLogEntry[] = [];
  const failedLogs: RequestLogEntry[] = [];
  const assetGroups = new Map<string, AssetGroup>();

  for (const log of logs) {
    // Failures always shown in full detail (only error field is available at request phase)
    if ((log as RequestLogEntry & { error?: string }).error) {
      failedLogs.push(log);
    } else if (ASSET_TYPES.has(log.resourceType.toLowerCase())) {
      // Group static assets by domain + type
      let hostname = log.url;
      try {
        hostname = new URL(log.url).hostname;
      } catch {
        // URL parse failed — use raw url as key
      }
      const key = `${hostname}:${log.resourceType}`;
      const group = assetGroups.get(key) || {
        domain: hostname,
        type: log.resourceType,
        count: 0,
        urls: [],
      };
      group.count++;
      if (group.urls.length < 3) {
        group.urls.push(log.url);
      }
      assetGroups.set(key, group);
    } else {
      // API/XHR and everything else shown individually
      apiLogs.push(log);
    }
  }

  return { apiLogs, failedLogs, assetGroups: Array.from(assetGroups.values()) };
}

/**
 * Format compressed network logs into a human-readable string section.
 */
function formatCompressedLogs(compressed: CompressedLogs): string {
  const lines: string[] = [];

  if (compressed.failedLogs.length > 0) {
    lines.push(`Failed requests (${compressed.failedLogs.length}):`);
    for (const log of compressed.failedLogs) {
      lines.push(`  [${log.method}] ${log.url} (${log.resourceType})`);
    }
  }

  if (compressed.apiLogs.length > 0) {
    lines.push(`API/XHR requests (${compressed.apiLogs.length}):`);
    for (const log of compressed.apiLogs) {
      lines.push(`  [${log.method}] ${log.url}`);
    }
  }

  if (compressed.assetGroups.length > 0) {
    // Group by domain for display
    const byDomain = new Map<string, string[]>();
    for (const group of compressed.assetGroups) {
      const parts = byDomain.get(group.domain) || [];
      parts.push(`${group.count} ${group.type.toLowerCase()}${group.count !== 1 ? 's' : ''}`);
      byDomain.set(group.domain, parts);
    }
    lines.push(`Asset requests:`);
    for (const [domain, parts] of byDomain) {
      lines.push(`  ${domain}: ${parts.join(', ')}`);
    }
  }

  return lines.join('\n');
}

// Helper function to match URL patterns (glob-like)
function matchesPattern(url: string, pattern: string): boolean {
  // Convert glob pattern to regex
  const regexPattern = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  try {
    return new RegExp(`^${regexPattern}$`, 'i').test(url);
  } catch {
    return url.includes(pattern);
  }
}

function estimatedStaticAssetResponseBytes(resourceType: string): number {
  return STATIC_ASSET_RESPONSE_BYTE_ESTIMATES[resourceType.toLowerCase()] ?? 0;
}

function ruleMatchesLog(rule: InterceptRule, log: RequestLogEntry): boolean {
  if (!matchesPattern(log.url, rule.pattern)) return false;
  if (rule.resourceTypes && rule.resourceTypes.length > 0) {
    return rule.resourceTypes.includes(log.resourceType.toLowerCase()) ||
      rule.resourceTypes.includes(log.resourceType);
  }
  return true;
}

function dryRunPreviewResult(args: {
  action: 'enable' | 'addRule';
  rules: InterceptRule[];
  existingRulesCount: number;
  loggedRequests: RequestLogEntry[];
  preset?: BandwidthPreset | null;
}): MCPResult {
  const matchedLogs = args.loggedRequests.filter((log) => args.rules.some((rule) => ruleMatchesLog(rule, log)));
  const samples = matchedLogs.slice(0, 10).map((log) => ({
    url: log.url,
    resourceType: log.resourceType,
    method: log.method,
  }));
  const wouldAffect = {
    count: matchedLogs.length,
    samples,
    details: {
      action: args.action,
      parsedRules: args.rules,
      parsedRuleCount: args.rules.length,
      existingRulesCount: args.existingRulesCount,
      observedRequestCount: args.loggedRequests.length,
      preset: args.preset ?? null,
    },
  };
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        action: 'request_intercept',
        dryRun: true,
        wouldAffect,
        message: `Dry-run preview: ${args.rules.length} rule(s) would be installed; ${matchedLogs.length} observed request(s) would match.`,
      }),
    }],
    structuredContent: {
      dryRun: true,
      wouldAffect,
      guidance: 'Pass dryRun:false (or omit) to execute.',
    },
    isError: false,
  };
}

const definition: MCPToolDefinition = {
  name: 'request_intercept',
  annotations: TOOL_ANNOTATIONS.request_intercept,
  description:
    'Intercept network requests (log, block, modify). ' +
    'preset="optimize-bandwidth" blocks Image/Media/Font/Stylesheet; ' +
    'preset="optimize-bandwidth-light" blocks Image/Media/Font. ' +
    'User block/allow/modify rules run after presets; explicit allow rules win. ' +
    'OPENCHROME_OPTIMIZE_BANDWIDTH=<preset> can auto-apply to new targets.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'string',
        description: 'Tab ID',
      },
      action: {
        type: 'string',
        enum: ['enable', 'disable', 'addRule', 'removeRule', 'listRules', 'getLogs', 'clearLogs'],
        description: 'Action to perform',
      },
      preset: {
        type: 'string',
        enum: ['optimize-bandwidth', 'optimize-bandwidth-light'],
        description:
          'Bandwidth preset: "optimize-bandwidth" blocks Image/Media/Font/Stylesheet; ' +
          '"optimize-bandwidth-light" blocks Image/Media/Font only.',
      },
      rule: {
        type: 'object',
        description: 'Rule definition (addRule)',
        properties: {
          pattern: {
            type: 'string',
            description: 'URL glob pattern',
          },
          resourceTypes: {
            type: 'array',
            items: { type: 'string' },
            description: 'Filter by resource type',
          },
          action: {
            type: 'string',
            enum: ['block', 'modify', 'log', 'allow'],
            description: 'Rule action',
          },
          modifyOptions: {
            type: 'object',
            description: 'Modify options',
            properties: {
              status: { type: 'number' },
              headers: { type: 'object' },
              body: { type: 'string' },
            },
          },
        },
      },
      ruleId: {
        type: 'string',
        description: 'Rule ID (removeRule)',
      },
      limit: {
        type: 'number',
        description: 'Max logs to return (getLogs)',
      },
      dryRun: {
        type: 'boolean',
        default: false,
        description: 'Preview enable/addRule rule installation without enabling interception, installing listeners, or mutating rules.',
      },
    },
    required: ['tabId', 'action'],
  },
};

// Cleanup listener when session ends
const setupCleanupListener = (() => {
  let initialized = false;
  return () => {
    if (initialized) return;
    initialized = true;

    const sessionManager = getSessionManager();
    sessionManager.addEventListener((event) => {
      if (
        event.type === 'session:target-closed' ||
        event.type === 'session:target-removed'
      ) {
        const targetId = event.targetId;
        if (targetId) {
          interceptStates.delete(targetId);
          console.error(`[RequestIntercept] Cleaned up state for closed tab ${targetId}`);
        }
      }
    });
  };
})();

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>
): Promise<MCPResult> => {
  const tabId = args.tabId as string;
  const action = args.action as string;
  const ruleArg = args.rule as {
    pattern?: string;
    resourceTypes?: string[];
    action?: 'block' | 'modify' | 'log' | 'allow';
    modifyOptions?: { status?: number; headers?: Record<string, string>; body?: string };
  } | undefined;
  const ruleId = args.ruleId as string | undefined;
  const limit = args.limit as number | undefined;
  const presetArg = args.preset as string | undefined;
  const dryRun = args.dryRun === true;

  // Validate preset before any other work
  if (presetArg !== undefined) {
    if (!SUPPORTED_PRESETS.includes(presetArg as BandwidthPreset)) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: 'unknown_preset', supported: SUPPORTED_PRESETS }),
          },
        ],
        isError: true,
      };
    }
  }

  const sessionManager = getSessionManager();

  // Setup cleanup listener on first use
  setupCleanupListener();

  if (!tabId) {
    return {
      content: [{ type: 'text', text: 'Error: tabId is required' }],
      isError: true,
    };
  }

  if (!action) {
    return {
      content: [{ type: 'text', text: 'Error: action is required' }],
      isError: true,
    };
  }

  try {
    const page = await sessionManager.getPage(sessionId, tabId, undefined, 'request_intercept');
    if (!page) {
      return {
        content: [{ type: 'text', text: `Error: Tab ${tabId} not found` }],
        isError: true,
      };
    }

    // Get or create state. dryRun must not create per-tab state by itself.
    let state = interceptStates.get(tabId);
    if (!state) {
      state = {
        enabled: false,
        rules: [],
        listener: null,
        loggedRequests: [],
        maxLogs: 500,
      };
      if (!dryRun) {
        interceptStates.set(tabId, state);
      }
    }

    switch (action) {
      case 'enable': {
        // Determine active preset: per-call arg takes precedence over env var.
        const activePreset = (presetArg as BandwidthPreset | undefined) ??
          (ENV_PRESET && SUPPORTED_PRESETS.includes(ENV_PRESET as BandwidthPreset)
            ? (ENV_PRESET as BandwidthPreset)
            : undefined);

        if (dryRun) {
          const nextRules = state.rules.filter((r) => !r.id.startsWith('preset-'));
          if (activePreset) {
            nextRules.unshift(...presetToRules(activePreset));
          }
          const installedRules = nextRules.filter((rule) => !state.rules.includes(rule));
          return dryRunPreviewResult({
            action: 'enable',
            rules: installedRules.length > 0 ? installedRules : nextRules,
            existingRulesCount: state.rules.length,
            loggedRequests: state.loggedRequests,
            preset: activePreset ?? null,
          });
        }

        if (state.enabled) {
          // Re-enable with an explicit `preset` arg replaces the previously
          // injected preset rules in-place. The listener already references
          // state.rules, so updates take effect immediately on the next request.
          // Calls without `preset` keep current behaviour (no-op + already_enabled).
          if (presetArg !== undefined) {
            state.rules = state.rules.filter((r) => !r.id.startsWith('preset-'));
            if (activePreset) {
              state.rules.unshift(...presetToRules(activePreset));
            }
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    action: 'enable',
                    status: 'preset_updated',
                    preset: activePreset ?? null,
                    rulesCount: state.rules.length,
                  }),
                },
              ],
            };
          }
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  action: 'enable',
                  status: 'already_enabled',
                  rulesCount: state.rules.length,
                }),
              },
            ],
          };
        }

        // Inject preset rules at the front; user rules (added via addRule) come after.
        // Always clear old injected preset rules first so re-enabling without a preset
        // leaves only the user's rules active.
        state.rules = state.rules.filter(r => !r.id.startsWith('preset-'));
        if (activePreset) {
          const presetRules = presetToRules(activePreset);
          state.rules.unshift(...presetRules);
        }

        await page.setRequestInterception(true);

        const metrics = getMetricsCollector();

        // Create request listener
        state.listener = async (request: HTTPRequest) => {
          const url = request.url();
          const resourceType = request.resourceType();

          let matched = false;
          let matchedRule: InterceptRule | null = null;

          // Two-pass rule evaluation: first pass finds the selected match,
          // second lets explicit allow rules override block/modify conflicts.
          for (const rule of state!.rules) {
            if (matchesPattern(url, rule.pattern)) {
              // Check resource type filter
              if (rule.resourceTypes && rule.resourceTypes.length > 0) {
                if (!rule.resourceTypes.includes(resourceType)) {
                  continue;
                }
              }
              matched = true;
              matchedRule = rule;
              break;
            }
          }

          if (matched && (matchedRule?.action === 'block' || matchedRule?.action === 'modify')) {
            const matchedBlockFromPreset = matchedRule.action === 'block' && matchedRule.id.startsWith('preset-');
            // Look for explicit overrides that also match. Allow wins over
            // block/modify conflicts, even when a modify rule is the first
            // match. User-authored modify rules may override injected preset
            // blocks, but not earlier user-authored blocks; that preserves the
            // pre-preset first-match semantics for custom rule sets.
            let modifyOverride: InterceptRule | null = null;
            for (const rule of state!.rules) {
              if (rule === matchedRule) continue;
              if (rule.action !== 'allow' && rule.action !== 'modify') continue;
              if (!matchesPattern(url, rule.pattern)) continue;
              if (rule.resourceTypes && rule.resourceTypes.length > 0) {
                if (!rule.resourceTypes.includes(resourceType)) continue;
              }
              if (rule.action === 'allow') {
                matchedRule = rule;
                break;
              }
              if (matchedBlockFromPreset && !modifyOverride) {
                modifyOverride = rule;
              }
            }
            if (matchedRule.action === 'block' && modifyOverride) {
              matchedRule = modifyOverride;
            }
          }

          const rtLabel = resourceType.toLowerCase();
          const estimatedResponseBytes = estimatedStaticAssetResponseBytes(resourceType);
          if (estimatedResponseBytes > 0) {
            metrics.inc(
              'openchrome_intercept_estimated_response_bytes_total',
              { resource_type: rtLabel, estimate_source: 'resource_type' },
              estimatedResponseBytes,
            );
          }

          // Log request if any log rules exist or matched
          const shouldLog = matched || state!.rules.some(r => r.action === 'log');
          if (shouldLog) {
            state!.loggedRequests.push({
              url: url.slice(0, 200),
              resourceType,
              method: request.method(),
              headers: request.headers(),
              timestamp: Date.now(),
              matched,
              ruleId: matchedRule?.id,
            });

            // Trim logs
            if (state!.loggedRequests.length > state!.maxLogs) {
              state!.loggedRequests = state!.loggedRequests.slice(-state!.maxLogs);
            }
          }

          // Apply rule action
          if (matchedRule) {
            try {
              if (matchedRule.action === 'block') {
                if (estimatedResponseBytes > 0) {
                  metrics.inc(
                    'openchrome_intercept_estimated_blocked_response_bytes_total',
                    { resource_type: rtLabel, estimate_source: 'resource_type' },
                    estimatedResponseBytes,
                  );
                }
                await request.abort('blockedbyclient');
                return;
              }

              if (matchedRule.action === 'modify' && matchedRule.modifyOptions) {
                await request.respond({
                  status: matchedRule.modifyOptions.status || 200,
                  headers: matchedRule.modifyOptions.headers || {},
                  body: matchedRule.modifyOptions.body || '',
                });
                return;
              }
            } catch (e) {
              // Request might already be handled
            }
          }

          // Continue with request
          try {
            await request.continue();
          } catch {
            // Request might already be handled
          }
        };

        page.on('request', state.listener);
        state.enabled = true;

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                action: 'enable',
                status: 'enabled',
                preset: activePreset ?? null,
                rulesCount: state.rules.length,
                message: 'Request interception enabled',
              }),
            },
          ],
        };
      }

      case 'disable': {
        if (!state.enabled) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  action: 'disable',
                  status: 'already_disabled',
                }),
              },
            ],
          };
        }

        if (state.listener) {
          page.off('request', state.listener);
          state.listener = null;
        }

        await page.setRequestInterception(false);
        state.enabled = false;

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                action: 'disable',
                status: 'disabled',
                message: 'Request interception disabled',
              }),
            },
          ],
        };
      }

      case 'addRule': {
        if (!ruleArg || !ruleArg.pattern || !ruleArg.action) {
          return {
            content: [
              {
                type: 'text',
                text: 'Error: rule with pattern and action is required',
              },
            ],
            isError: true,
          };
        }

        const newRule: InterceptRule = {
          id: dryRun ? 'dry-run-rule' : `rule-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          pattern: ruleArg.pattern,
          resourceTypes: ruleArg.resourceTypes,
          action: ruleArg.action,
          modifyOptions: ruleArg.modifyOptions,
        };

        if (dryRun) {
          return dryRunPreviewResult({
            action: 'addRule',
            rules: [newRule],
            existingRulesCount: state.rules.length,
            loggedRequests: state.loggedRequests,
          });
        }

        state.rules.push(newRule);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                action: 'addRule',
                rule: newRule,
                totalRules: state.rules.length,
                message: `Added rule ${newRule.id}`,
              }),
            },
          ],
        };
      }

      case 'removeRule': {
        if (!ruleId) {
          return {
            content: [{ type: 'text', text: 'Error: ruleId is required' }],
            isError: true,
          };
        }

        const index = state.rules.findIndex((r) => r.id === ruleId);
        if (index === -1) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  action: 'removeRule',
                  status: 'not_found',
                  message: `Rule ${ruleId} not found`,
                }),
              },
            ],
          };
        }

        state.rules.splice(index, 1);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                action: 'removeRule',
                removedId: ruleId,
                remainingRules: state.rules.length,
                message: `Removed rule ${ruleId}`,
              }),
            },
          ],
        };
      }

      case 'listRules': {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                action: 'listRules',
                enabled: state.enabled,
                rules: state.rules,
                count: state.rules.length,
              }),
            },
          ],
        };
      }

      case 'getLogs': {
        let logs = state.loggedRequests;
        if (limit && limit > 0) {
          logs = logs.slice(-limit);
        }

        // Strip headers to whitelist before building response
        const logsWithStrippedHeaders = logs.map((log) => ({
          ...log,
          headers: stripHeaders(log.headers),
          headersStripped: true,
        }));

        // Group asset requests, keep API/failures individually
        const compressed = groupAssetRequests(logsWithStrippedHeaders);

        // Calculate stats
        const stats = {
          total: state.loggedRequests.length,
          returned: logs.length,
          blocked: state.loggedRequests.filter(l => l.matched).length,
          byType: {} as Record<string, number>,
          assetGroupsCount: compressed.assetGroups.length,
        };
        for (const log of state.loggedRequests) {
          stats.byType[log.resourceType] = (stats.byType[log.resourceType] || 0) + 1;
        }

        const summary = formatCompressedLogs(compressed);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                action: 'getLogs',
                apiLogs: compressed.apiLogs,
                failedLogs: compressed.failedLogs,
                assetGroups: compressed.assetGroups,
                summary,
                stats,
                headersStripped: true,
              }),
            },
          ],
        };
      }

      case 'clearLogs': {
        const clearedCount = state.loggedRequests.length;
        state.loggedRequests = [];

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                action: 'clearLogs',
                clearedCount,
                message: `Cleared ${clearedCount} request logs`,
              }),
            },
          ],
        };
      }

      default:
        return {
          content: [
            {
              type: 'text',
              text: `Error: Unknown action "${action}"`,
            },
          ],
          isError: true,
        };
    }
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Request intercept error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
};

export function registerRequestInterceptTool(server: MCPServer): void {
  server.registerTool('request_intercept', handler, definition);
}
