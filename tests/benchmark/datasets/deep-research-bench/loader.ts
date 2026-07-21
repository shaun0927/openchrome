/**
 * Dataset loader for DeepResearch Bench (browser-side adapter only).
 *
 * Dataset: Ayanami0730/deep_research_bench
 * Source:  https://github.com/Ayanami0730/deep_research_bench
 * License: MIT
 * Paper:   DeepResearch Bench — RACE + FACT evaluation of deep-research
 *          agents on the open web.
 *
 * Scope of this adapter
 * ---------------------
 * DeepResearch Bench is a *model-inclusive* benchmark — the upstream
 * repo runs an LLM agent end-to-end and scores its final report with
 * RACE (Reference-Anchored Comparative Evaluation) and FACT
 * (Fact-check Automated). openchrome is a browser MCP server; it does
 * not run models. This adapter therefore ports only the **browser-side
 * parts** of the benchmark:
 *
 *   1. the task schema (query, domain, expected sources, reference len)
 *   2. a fixture loader (CI-safe, no network) + optional live fetcher
 *   3. a "browser-only" runner that measures whether openchrome can
 *      surface the required pages within a step / token budget, and
 *      writes the trajectory into the standard benchmark result envelope.
 *
 * Scoring (RACE + FACT) is out of scope — a downstream user can pipe
 * this adapter's trajectory JSON into the upstream repo's scorer.
 *
 * Origin credit
 * -------------
 * The task schema, RACE-eligibility fields, and result envelope layout
 * are inspired by the upstream repo's README and dataset card. No
 * upstream source code was copied — this is a clean-room adapter.
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * A DeepResearch Bench task, browser-adapter subset. Fields the model-side
 * scorer needs but the browser does not (e.g. `oracle_answer`, `race_rubric`)
 * are intentionally out of scope here.
 */
export interface DeepResearchTask {
  /** Unique task id (e.g. `drb-en-042`). */
  task_id: string;
  /** Language of the query. */
  language: 'en' | 'zh';
  /** Domain tag from the upstream taxonomy (e.g. `Science`, `Finance`). */
  domain: string;
  /** The natural-language research query. */
  query: string;
  /**
   * URLs the upstream dataset lists as authoritative or expected sources.
   * The browser-side runner uses these as a coverage proxy — "did we visit
   * the pages a strong agent would visit?".
   */
  expected_sources: string[];
  /**
   * Approximate number of tool calls a reference agent needed. Used as a
   * step budget hint; the runner may go over.
   */
  reference_steps: number;
}

export interface LoadDeepResearchOptions {
  source: 'fixture' | 'file';
  /** For `source='file'`: absolute path to a JSON array of tasks. */
  filePath?: string;
  /** Cap the number of tasks returned (post-load). */
  limit?: number;
  /** Filter to a specific language. */
  language?: 'en' | 'zh';
  /** Filter to a specific domain (case-insensitive). */
  domain?: string;
}

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'sample-8.json');

function validateTask(raw: unknown, index: number): DeepResearchTask {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`DeepResearch task ${index} is not an object`);
  }
  const t = raw as Record<string, unknown>;
  const requireString = (field: string): string => {
    const v = t[field];
    if (typeof v !== 'string' || v.length === 0) {
      throw new Error(`DeepResearch task ${index}: field "${field}" must be a non-empty string`);
    }
    return v;
  };
  const requireLang = (): 'en' | 'zh' => {
    const v = t.language;
    if (v !== 'en' && v !== 'zh') {
      throw new Error(`DeepResearch task ${index}: language must be "en" or "zh"`);
    }
    return v;
  };
  const requireNumber = (field: string): number => {
    const v = t[field];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      throw new Error(`DeepResearch task ${index}: field "${field}" must be a non-negative number`);
    }
    return v;
  };
  const requireStringArray = (field: string): string[] => {
    const v = t[field];
    if (!Array.isArray(v)) {
      throw new Error(`DeepResearch task ${index}: field "${field}" must be an array`);
    }
    for (const entry of v) {
      if (typeof entry !== 'string' || entry.length === 0) {
        throw new Error(`DeepResearch task ${index}: "${field}" entries must be non-empty strings`);
      }
    }
    return v as string[];
  };
  return {
    task_id: requireString('task_id'),
    language: requireLang(),
    domain: requireString('domain'),
    query: requireString('query'),
    expected_sources: requireStringArray('expected_sources'),
    reference_steps: requireNumber('reference_steps'),
  };
}

export function loadDeepResearchTasks(options: LoadDeepResearchOptions): DeepResearchTask[] {
  let raw: unknown;
  if (options.source === 'fixture') {
    const text = fs.readFileSync(FIXTURE_PATH, 'utf-8');
    raw = JSON.parse(text);
  } else if (options.source === 'file') {
    if (!options.filePath) {
      throw new Error('loadDeepResearchTasks: source="file" requires filePath');
    }
    const text = fs.readFileSync(options.filePath, 'utf-8');
    raw = JSON.parse(text);
  } else {
    throw new Error(`loadDeepResearchTasks: unknown source ${(options as { source: string }).source}`);
  }
  if (!Array.isArray(raw)) {
    throw new Error('DeepResearch dataset root must be an array');
  }
  let tasks = raw.map((entry, i) => validateTask(entry, i));
  if (options.language) tasks = tasks.filter((t) => t.language === options.language);
  if (options.domain) {
    const wanted = options.domain.toLowerCase();
    tasks = tasks.filter((t) => t.domain.toLowerCase() === wanted);
  }
  if (options.limit && options.limit > 0) tasks = tasks.slice(0, options.limit);
  return tasks;
}
