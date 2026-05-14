import type { WebVoyagerTask } from '../types';

const task: WebVoyagerTask = {
  name: 'task-06-arxiv-2401-13919-abstract',
  instruction:
    'Open arXiv preprint 2401.13919 (WebVoyager) and confirm Hongliang He is listed ' +
    'as an author.',
  contract: {
    postconditions: {
      kind: 'and',
      children: [
        { kind: 'url', pattern: '^https://arxiv\\.org/abs/2401\\.13919(?:v\\d+)?/?$' },
        { kind: 'dom_text', selector: 'body', contains: 'Hongliang He' },
      ],
    },
  },
  timeout_ms: 90_000,
  pending: true,
  rationale:
    'arXiv abstracts are versioned and historical metadata (author list) is immutable. ' +
    'Tests retrieval of a long-form page where the agent must locate the abstract block.',
};

export default task;
