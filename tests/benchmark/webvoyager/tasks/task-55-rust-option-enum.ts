import type { WebVoyagerTask } from '../types';

const task: WebVoyagerTask = {
  name: 'task-55-rust-option-enum',
  instruction: 'Visit https://doc.rust-lang.org/std/option/enum.Option.html and confirm the page mentions "Option".',
  contract: {
    postconditions: {
      kind: 'and',
      children: [
        { kind: 'url', pattern: '^https:\\/\\/doc\\.rust-lang\\.org\\/std\\/option\\/enum\\.Option\\.html' },
        { kind: 'dom_text', selector: 'body', contains: 'Option' },
      ],
    },
  },
  timeout_ms: 90_000,
  pending: true,
  rationale:
    'Rust std::option::Option docs. Source is a low-volatility public reference page (license-safe). Task ships as pending until the next-session real-LLM run records a transcript.',
};

export default task;
