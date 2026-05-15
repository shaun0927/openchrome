import type { WebVoyagerTask } from '../types';

const task: WebVoyagerTask = {
  name: 'task-11-example-org-title',
  instruction: 'Visit https://example.org and report the page heading.',
  contract: {
    postconditions: {
      kind: 'and',
      children: [
        { kind: 'url', pattern: '^https://example\\.org/?$' },
        { kind: 'dom_text', selector: 'h1', contains: 'Example Domain' },
        { kind: 'dom_count', selector: 'h1', op: 'gte', value: 1 },
      ],
    },
  },
  timeout_ms: 60_000,
  pending: true,
  rationale:
    'example.org is RFC-2606 reserved and serves the same effectively-immutable ' +
    '"Example Domain" page as example.com — a second near-zero-brittleness smoke task.',
};

export default task;
