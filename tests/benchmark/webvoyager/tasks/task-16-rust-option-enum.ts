import type { WebVoyagerTask } from '../types';

const task: WebVoyagerTask = {
  name: 'task-16-rust-option-enum',
  instruction:
    'Open the Rust standard library documentation for the Option enum and confirm it ' +
    'represents an optional value with the variants Some and None.',
  contract: {
    postconditions: {
      kind: 'and',
      children: [
        { kind: 'url', pattern: '^https://doc\\.rust-lang\\.org/.*option/enum\\.Option\\.html' },
        { kind: 'dom_text', selector: 'body', contains: 'Some' },
        { kind: 'dom_text', selector: 'body', contains: 'None' },
      ],
    },
  },
  timeout_ms: 90_000,
  pending: true,
  rationale:
    'Rust std docs. Option\'s Some/None variants are foundational and stable; the canonical ' +
    'doc URL has not moved across releases.',
};

export default task;
