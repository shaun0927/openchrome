import type { WebVoyagerTask } from '../types';

const task: WebVoyagerTask = {
  name: 'task-01-example-com-title',
  instruction: 'Visit https://example.com and report the page title.',
  contract: {
    postconditions: {
      kind: 'and',
      children: [
        { kind: 'url', pattern: '^https://example\\.com/?$' },
        { kind: 'dom_text', selector: 'h1', contains: 'Example Domain' },
        { kind: 'dom_count', selector: 'h1', op: 'gte', value: 1 },
      ],
    },
  },
  timeout_ms: 60_000,
  rationale:
    'Smoke task. example.com is RFC-2606 reserved and the H1 has been "Example Domain" ' +
    'since at least 2013; this verifies the harness wiring end-to-end with effectively ' +
    'zero brittleness.',
};

export default task;
