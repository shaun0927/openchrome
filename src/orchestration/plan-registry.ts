/**
 * PlanRegistry — Manages compiled plan storage, loading, matching, and stats tracking.
 *
 * Plans are stored at {basePath}/plan-registry.json (index) and
 * {basePath}/plans/{planId}.json (individual plan files).
 */

import * as fs from 'fs';
import * as path from 'path';
import type {
  CompiledPlan,
  CompiledStep,
  PlanEntry,
  PlanRegistryData,
  TaskPattern,
} from '../types/plan-cache';

const DEFAULT_BASE_PATH = '.chrome-parallel/plans/';
const REGISTRY_FILENAME = 'plan-registry.json';
const PLANS_SUBDIR = 'plans';
const REGISTRY_VERSION = '1.0.0';

export class PlanRegistry {
  private basePath: string;
  private registryPath: string;
  private plansDir: string;
  private data: PlanRegistryData;

  constructor(basePath: string = DEFAULT_BASE_PATH) {
    this.basePath = basePath;
    this.registryPath = path.join(basePath, REGISTRY_FILENAME);
    this.plansDir = path.join(basePath, PLANS_SUBDIR);
    this.data = {
      version: REGISTRY_VERSION,
      plans: [],
      updatedAt: Date.now(),
    };
  }

  /**
   * Load plan registry from disk.
   */
  load(): void {
    try {
      const raw = fs.readFileSync(this.registryPath, 'utf-8');
      const parsed: PlanRegistryData = JSON.parse(raw);
      this.data = parsed;
    } catch {
      // Best-effort — start with empty registry
      this.data = {
        version: REGISTRY_VERSION,
        plans: [],
        updatedAt: Date.now(),
      };
    }
  }

  /**
   * Persist plan registry to disk.
   */
  save(): void {
    try {
      fs.mkdirSync(this.basePath, { recursive: true });
      this.data.updatedAt = Date.now();
      fs.writeFileSync(this.registryPath, JSON.stringify(this.data, null, 2));
    } catch {
      // Best-effort
    }
  }

  /**
   * Find the best matching plan entry for a given task and URL.
   * Filters by urlPattern, taskKeywords, and confidence threshold.
   * Returns the highest-confidence match, or null if none found.
   */
  matchTask(task: string, url: string): PlanEntry | null {
    const taskLower = task.toLowerCase();

    const candidates = this.data.plans.filter(entry => {
      // Filter by confidence threshold
      if (entry.confidence < entry.minConfidenceToUse) {
        return false;
      }

      // Filter by urlPattern (if specified)
      if (entry.pattern.urlPattern) {
        try {
          const regex = new RegExp(entry.pattern.urlPattern);
          if (!regex.test(url)) {
            return false;
          }
        } catch {
          // Invalid regex — skip this entry
          return false;
        }
      }

      // Filter by taskKeywords (all must be present, case-insensitive)
      const allKeywordsMatch = entry.pattern.taskKeywords.every(kw =>
        taskLower.includes(kw.toLowerCase())
      );
      if (!allKeywordsMatch) {
        return false;
      }

      return true;
    });

    if (candidates.length === 0) {
      return null;
    }

    // Sort by confidence desc, then successCount desc
    candidates.sort((a, b) => {
      if (b.confidence !== a.confidence) {
        return b.confidence - a.confidence;
      }
      return b.stats.successCount - a.stats.successCount;
    });

    return candidates[0];
  }

  /**
   * Load a compiled plan from disk by its registry entry.
   */
  loadPlan(entry: PlanEntry): CompiledPlan | null {
    try {
      const planPath = path.isAbsolute(entry.planPath)
        ? entry.planPath
        : path.join(this.basePath, entry.planPath);
      const raw = fs.readFileSync(planPath, 'utf-8');
      return JSON.parse(raw) as CompiledPlan;
    } catch {
      return null;
    }
  }

  /**
   * Update execution stats for a plan and recalculate confidence.
   */
  updateStats(planId: string, success: boolean, durationMs: number): void {
    const entry = this.data.plans.find(p => p.id === planId);
    if (!entry) return;

    const stats = entry.stats;
    stats.totalExecutions++;
    if (success) {
      stats.successCount++;
    } else {
      stats.failCount++;
    }

    // Rolling average for duration
    if (stats.totalExecutions === 1) {
      stats.avgDurationMs = durationMs;
    } else {
      stats.avgDurationMs = Math.round(
        (stats.avgDurationMs * (stats.totalExecutions - 1) + durationMs) /
          stats.totalExecutions
      );
    }
    stats.lastUsed = Date.now();

    // Recalculate confidence as success rate
    entry.confidence = stats.totalExecutions > 0
      ? stats.successCount / stats.totalExecutions
      : 0;

    this.save();
  }

  /**
   * Register a new compiled plan with the given task pattern.
   * Saves plan JSON to disk and adds entry to the registry.
   */
  registerPlan(plan: CompiledPlan, pattern: TaskPattern): PlanEntry {
    try {
      fs.mkdirSync(this.plansDir, { recursive: true });
    } catch {
      // Best-effort
    }

    const planFilename = `${plan.id}.json`;
    const planPath = path.join(PLANS_SUBDIR, planFilename);
    const planFullPath = path.join(this.plansDir, planFilename);

    try {
      fs.writeFileSync(planFullPath, JSON.stringify(plan, null, 2));
    } catch {
      // Best-effort
    }

    // Remove existing entry with same ID (if any)
    this.data.plans = this.data.plans.filter(p => p.id !== plan.id);

    const entry: PlanEntry = {
      id: plan.id,
      pattern,
      planPath,
      stats: {
        totalExecutions: 0,
        successCount: 0,
        failCount: 0,
        avgDurationMs: 0,
        lastUsed: 0,
      },
      confidence: 0.5, // Initial neutral confidence
      minConfidenceToUse: 0.3,
    };

    this.data.plans.push(entry);
    this.save();

    return entry;
  }

  /**
   * Get all plan entries.
   */
  getEntries(): PlanEntry[] {
    return this.data.plans;
  }

  /**
   * Get a single plan entry by ID.
   */
  getEntry(planId: string): PlanEntry | null {
    return this.data.plans.find(p => p.id === planId) ?? null;
  }

  /**
   * Returns the default compiled plans (e.g. X/Twitter tweet extraction).
   */
  static getDefaultPlans(): Array<{ plan: CompiledPlan; pattern: TaskPattern }> {
    const tweetExtractionScript = `
(function() {
  const articles = document.querySelectorAll('article[data-testid="tweet"]');
  const tweets = [];
  for (let i = 0; i < Math.min(5, articles.length); i++) {
    const article = articles[i];
    const textEl = article.querySelector('[data-testid="tweetText"]');
    const timeEl = article.querySelector('time');
    tweets.push({
      text: textEl ? textEl.innerText : '',
      time: timeEl ? timeEl.getAttribute('datetime') : null,
    });
  }
  return JSON.stringify({ tweetCount: tweets.length, tweets });
})();
`.trim();

    const steps: CompiledStep[] = [
      {
        order: 1,
        tool: 'wait_for',
        args: { ms: 2000 },
        timeout: 5000,
      },
      {
        order: 2,
        tool: 'javascript_tool',
        args: { script: tweetExtractionScript },
        timeout: 10000,
        retryOnFail: false,
        parseResult: {
          format: 'json',
          storeAs: 'extractionResult',
        },
      },
    ];

    const plan: CompiledPlan = {
      id: 'x-tweet-extraction-v1',
      version: '1.0.0',
      description: 'Extract tweets from an X/Twitter page via DOM',
      parameters: {
        tabId: {
          source: 'worker_config',
          default: undefined,
        },
      },
      steps,
      errorHandlers: [],
      successCriteria: {
        minDataItems: 1,
        requiredFields: ['extractionResult'],
      },
    };

    const pattern: TaskPattern = {
      urlPattern: 'https://(x|twitter)\\.com/.*',
      taskKeywords: ['tweet', 'extract'],
    };

    return [{ plan, pattern }];
  }
}

// Singleton instance cache
let _instance: PlanRegistry | null = null;
let _instanceBasePath: string | null = null;

/**
 * Get a singleton PlanRegistry instance.
 * Pass basePath to create/replace the singleton with a new base path.
 */
export function getPlanRegistry(basePath?: string): PlanRegistry {
  const resolvedPath = basePath ?? DEFAULT_BASE_PATH;
  if (!_instance || _instanceBasePath !== resolvedPath) {
    _instance = new PlanRegistry(resolvedPath);
    _instanceBasePath = resolvedPath;
    _instance.load();
  }
  return _instance;
}
