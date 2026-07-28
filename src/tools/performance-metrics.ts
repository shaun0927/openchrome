/**
 * Performance Metrics Tool - Collect page performance data
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolContext, ToolHandler } from '../types/mcp';
import { TOOL_ANNOTATIONS } from '../types/tool-annotations';
import { getSessionManager } from '../session-manager';
import { withTimeout } from '../utils/with-timeout';
import { buildPerformanceContractFacts } from '../contracts/contract-facts';

const definition: MCPToolDefinition = {
  name: 'performance_metrics',
  description: 'Get page performance metrics.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'string',
        description: 'Tab ID to get metrics from',
      },
      type: {
        type: 'string',
        enum: ['all', 'puppeteer', 'navigation', 'paint', 'resource'],
        description: 'Metrics type. Default: all',
      },
      includeResources: {
        type: 'boolean',
        description: 'Include resource timing entries',
      },
    },
    required: ['tabId'],
  },
  annotations: TOOL_ANNOTATIONS.performance_metrics,
};

interface PerformanceMetrics {
  puppeteer?: Record<string, number>;
  navigation?: Record<string, number>;
  paint?: Record<string, number>;
  resource?: Array<{
    name: string;
    type: string;
    duration: number;
    size: number;
  }>;
  summary?: {
    pageLoadTime: number | null;
    domContentLoaded: number | null;
    firstPaint: number | null;
    firstContentfulPaint: number | null;
    jsHeapUsedMB: number | null;
    totalResources: number;
    largestResource: string | null;
  };
}

interface ResourceContractSummary {
  count: number;
  totalTransferSize: number;
  largestTransferSize: number;
  maxDuration: number;
}
const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>,
  context?: ToolContext,
): Promise<MCPResult> => {
  const tabId = args.tabId as string;
  const type = (args.type as string | undefined) ?? 'all';
  const includeResources = (args.includeResources as boolean | undefined) ?? false;

  const sessionManager = getSessionManager();

  if (!tabId) {
    return {
      content: [{ type: 'text', text: 'Error: tabId is required' }],
      isError: true,
    };
  }

  try {
    const page = await sessionManager.getPage(sessionId, tabId, undefined, 'performance_metrics');
    if (!page) {
      return {
        content: [{ type: 'text', text: `Error: Tab ${tabId} not found` }],
        isError: true,
      };
    }

    const metrics: PerformanceMetrics = {};
    let resourceContractSummary: ResourceContractSummary | undefined;
    // Puppeteer metrics
    if (type === 'all' || type === 'puppeteer') {
      const puppeteerMetrics = await withTimeout(
        page.metrics(),
        5000,
        'performance_metrics',
        context,
      );
      metrics.puppeteer = {};
      for (const [key, value] of Object.entries(puppeteerMetrics)) {
        if (typeof value === 'number') {
          metrics.puppeteer[key] = value;
        }
      }
    }

    // Navigation timing
    if (type === 'all' || type === 'navigation') {
      const navigationTiming = await withTimeout(page.evaluate(() => {
        const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
        if (!nav) return null;
        return {
          redirectTime: nav.redirectEnd - nav.redirectStart,
          dnsTime: nav.domainLookupEnd - nav.domainLookupStart,
          connectTime: nav.connectEnd - nav.connectStart,
          requestTime: nav.responseStart - nav.requestStart,
          responseTime: nav.responseEnd - nav.responseStart,
          domInteractive: nav.domInteractive,
          domContentLoadedEventEnd: nav.domContentLoadedEventEnd,
          loadEventEnd: nav.loadEventEnd,
          duration: nav.duration,
        };
      }), 5000, 'performance_metrics', context);
      if (navigationTiming) {
        metrics.navigation = navigationTiming;
      }
    }

    // Paint timing
    if (type === 'all' || type === 'paint') {
      const paintTiming = await withTimeout(page.evaluate(() => {
        const paints = performance.getEntriesByType('paint');
        const result: Record<string, number> = {};
        for (const paint of paints) {
          result[paint.name] = paint.startTime;
        }
        return result;
      }), 5000, 'performance_metrics', context);
      metrics.paint = paintTiming;
    }

    // Resource timing
    if ((type === 'all' && includeResources) || type === 'resource') {
      const resourceTiming = await withTimeout(page.evaluate(() => {
        const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
        const measured = resources.filter((resource) => (
          Number.isFinite(resource.duration) && Number.isFinite(resource.transferSize)
        ));
        return {
          entries: resources.slice(0, 50).map(r => ({
            name: r.name.split('?')[0].split('/').pop() || r.name,
            type: r.initiatorType,
            duration: Math.round(r.duration),
            size: r.transferSize || 0,
          })),
          summary: {
            count: measured.length,
            totalTransferSize: measured.reduce(
              (sum, resource) => sum + Math.max(0, resource.transferSize),
              0,
            ),
            largestTransferSize: measured.reduce(
              (largest, resource) => Math.max(largest, Math.max(0, resource.transferSize)),
              0,
            ),
            maxDuration: measured.reduce(
              (largest, resource) => Math.max(largest, Math.max(0, resource.duration)),
              0,
            ),
          },
        };
      }), 5000, 'performance_metrics', context);
      metrics.resource = resourceTiming.entries;
      resourceContractSummary = resourceTiming.summary;
    }

    // Calculate summary
    if (type === 'all') {
      const jsHeapUsed = metrics.puppeteer?.JSHeapUsedSize;
      const resources = metrics.resource || [];

      metrics.summary = {
        pageLoadTime: metrics.navigation?.loadEventEnd ?? null,
        domContentLoaded: metrics.navigation?.domContentLoadedEventEnd ?? null,
        firstPaint: metrics.paint?.['first-paint'] ?? null,
        firstContentfulPaint: metrics.paint?.['first-contentful-paint'] ?? null,
        jsHeapUsedMB: jsHeapUsed ? Math.round((jsHeapUsed / 1024 / 1024) * 100) / 100 : null,
        totalResources: resources.length,
        largestResource: resources.length > 0
          ? resources.sort((a, b) => b.size - a.size)[0]?.name || null
          : null,
      };
    }

    const contractFacts = buildPerformanceContractFacts({
      sessionId,
      targetId: tabId,
      capturedAt: new Date().toISOString(),
      metrics: {
        ...metrics,
        ...(resourceContractSummary
          ? { resource_summary: resourceContractSummary }
          : {}),
      },
    });
    const payload = {
      action: 'performance_metrics',
      type,
      metrics,
      contract_facts: contractFacts,
      message: `Performance metrics collected (type: ${type})`,
    };

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(payload),
        },
      ],
      structuredContent: payload,
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Performance metrics error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
};

export function registerPerformanceMetricsTool(server: MCPServer): void {
  server.registerTool('performance_metrics', handler, definition);
}
