/**
 * Step expansion — maps playbook verb + args to MCP tool name + call args.
 *
 * Static map of 9 verbs. `assert` maps to `oc_assert` with the YAML node
 * passed verbatim as the `assertion` field (including nested and/or/not).
 */

import type { Verb } from './parse';

export interface ExpandedStep {
  tool: string;
  callArgs: Record<string, unknown>;
}

type ArgMapper = (args: Record<string, unknown>) => Record<string, unknown>;

const VERB_MAP: Record<Verb, { tool: string; mapArgs: ArgMapper }> = {
  navigate: {
    tool: 'navigate',
    mapArgs: (args) => args,
  },
  interact: {
    tool: 'interact',
    mapArgs: (args) => args,
  },
  act: {
    tool: 'act',
    mapArgs: (args) => args,
  },
  fill_form: {
    tool: 'fill_form',
    mapArgs: (args) => args,
  },
  wait_for: {
    tool: 'wait_for',
    mapArgs: (args) => args,
  },
  page_screenshot: {
    tool: 'page_screenshot',
    mapArgs: (args) => args,
  },
  read_page: {
    tool: 'read_page',
    mapArgs: (args) => args,
  },
  javascript_tool: {
    tool: 'javascript_tool',
    mapArgs: (args) => args,
  },
  assert: {
    tool: 'oc_assert',
    // Pass the entire YAML node verbatim as the `assertion` field.
    mapArgs: (args) => ({ assertion: args }),
  },
};

export function expandStep(verb: Verb, args: Record<string, unknown>): ExpandedStep {
  const entry = VERB_MAP[verb];
  // VERB_MAP covers all 9 verbs — this is a type-level guarantee, but guard anyway
  if (!entry) {
    throw new Error(`Unknown verb "${verb}"`);
  }
  return {
    tool: entry.tool,
    callArgs: entry.mapArgs(args),
  };
}
