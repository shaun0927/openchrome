import type { WebVoyagerTask } from '../types';

const task: WebVoyagerTask = {
  name: 'task-57-rust-vec',
  instruction: 'Visit https://doc.rust-lang.org/std/vec/struct.Vec.html and confirm the page mentions "Vec".',
  contract: {
    postconditions: {
      kind: 'and',
      children: [
        { kind: 'url', pattern: '^https:\\/\\/doc\\.rust-lang\\.org\\/std\\/vec\\/struct\\.Vec\\.html' },
        { kind: 'dom_text', selector: 'body', contains: 'Vec' },
      ],
    },
  },
  timeout_ms: 90_000,
  pending: true,
  rationale:
    'Rust std::vec::Vec docs. Source is a low-volatility public reference page (license-safe). Task ships as pending until the next-session real-LLM run records a transcript.',
};

export default task;
