/**
 * Action Templates - Pre-compiled action sequences for common browser workflows.
 *
 * When the user's instruction matches a template, the cached sequence is used
 * instead of NL parsing. This is faster and more reliable for known patterns.
 */

import { ParsedAction } from './action-parser';

export interface ActionTemplate {
  id: string;
  name: string;
  description: string;
  /** Regex pattern to match the instruction. Named groups become template variables. */
  pattern: RegExp;
  /** Function that returns the action sequence, using captured groups as variables. */
  build: (vars: Record<string, string>) => ParsedAction[];
}

/**
 * Built-in action templates for common workflows.
 */
export const ACTION_TEMPLATES: ActionTemplate[] = [
  // Login template
  {
    id: 'login',
    name: 'Login',
    description: 'Log in with email/username and password',
    pattern: /^(?:log\s*in|sign\s*in)\s+(?:with\s+)?(?<email>[^\s]+)\s+(?:and\s+)?(?<password>.+)$/i,
    build: (vars) => [
      { action: 'type', target: 'email', value: vars.email },
      { action: 'type', target: 'password', value: vars.password },
      { action: 'click', target: 'login button' },
    ],
  },
  // Korean login
  {
    id: 'login-kr',
    name: 'Login (Korean)',
    description: '로그인',
    pattern: /^(?<email>[^\s]+)(?:와|과|하고)\s*(?<password>.+?)(?:로|으로)\s*(?:로그인|로그 인|사인 인)$/,
    build: (vars) => [
      { action: 'type', target: 'email', value: vars.email },
      { action: 'type', target: 'password', value: vars.password },
      { action: 'click', target: '로그인 버튼' },
    ],
  },
  // Search template
  {
    id: 'search',
    name: 'Search',
    description: 'Search for a query',
    pattern: /^search\s+(?:for\s+)?(?<query>.+?)(?:\s+in\s+(?:the\s+)?(?<target>.+?))?$/i,
    build: (vars) => {
      const steps: ParsedAction[] = [];
      if (vars.target) {
        steps.push({ action: 'type', target: vars.target, value: vars.query });
      } else {
        steps.push({ action: 'type', target: 'search', value: vars.query });
      }
      steps.push({ action: 'click', target: 'search button' });
      return steps;
    },
  },
  // Korean search
  {
    id: 'search-kr',
    name: 'Search (Korean)',
    description: '검색',
    pattern: /^(?<query>.+?)(?:을|를)?\s*검색$/,
    build: (vars) => [
      { action: 'type', target: 'search', value: vars.query },
      { action: 'click', target: '검색 버튼' },
    ],
  },
  // Form fill template
  {
    id: 'fill-form',
    name: 'Fill Form',
    description: 'Fill form fields with key-value pairs',
    pattern: /^fill\s+(?:out\s+)?(?:the\s+)?(?:(?<formName>.+?)\s+)?(?:form\s+)?with\s+(?<pairs>.+)$/i,
    build: (vars) => {
      const actions: ParsedAction[] = [];
      // Parse comma-separated key=value or "key value" pairs
      const pairs = vars.pairs.split(/,\s*/);
      for (const pair of pairs) {
        const kv = pair.match(/^(.+?)\s+(.+)$/) || pair.match(/^(.+?)=(.+)$/);
        if (kv) {
          actions.push({ action: 'type', target: kv[1].trim(), value: kv[2].trim() });
        }
      }
      return actions;
    },
  },
  // Navigate and do template
  {
    id: 'goto-and-do',
    name: 'Navigate and Act',
    description: 'Go to a URL and perform an action',
    pattern: /^(?:go\s+to|navigate\s+to|open|visit)\s+(?<url>https?:\/\/\S+)\s+(?:and|then)\s+(?<action>.+)$/i,
    build: (vars) => {
      // The remaining action part will be parsed by the action parser
      // For templates, we just handle the navigate part
      const { parseInstruction } = require('./action-parser');
      const parsed = parseInstruction(vars.action);
      return [
        { action: 'navigate', value: vars.url },
        ...(parsed.success ? parsed.actions : []),
      ];
    },
  },
];

/**
 * Try to match instruction against known templates.
 * Returns the action sequence if matched, null otherwise.
 */
export function matchTemplate(instruction: string): { template: ActionTemplate; actions: ParsedAction[] } | null {
  const trimmed = instruction.trim();

  for (const tpl of ACTION_TEMPLATES) {
    const match = trimmed.match(tpl.pattern);
    if (match && match.groups) {
      try {
        const actions = tpl.build(match.groups);
        if (actions.length > 0) {
          return { template: tpl, actions };
        }
      } catch {
        // Template build failed — try next template
        continue;
      }
    }
  }

  return null;
}
