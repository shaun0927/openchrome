import type { WebVoyagerTask } from '../types';

const task: WebVoyagerTask = {
  name: 'task-54-rust-string-trim',
  instruction: 'Visit https://doc.rust-lang.org/std/string/struct.String.html and confirm the page mentions "String".',
  contract: {
    postconditions: {
      kind: 'and',
      children: [
        { kind: 'url', pattern: '^https:\\/\\/doc\\.rust-lang\\.org\\/std\\/string\\/struct\\.String\\.html' },
        { kind: 'dom_text', selector: 'body', contains: 'String' },
      ],
    },
  },
  timeout_ms: 90_000,
  pending: true,
  rationale:
    'Rust std::string::String docs. Source is a low-volatility public reference page (license-safe). Task ships as pending until the next-session real-LLM run records a transcript.',
};

export default task;
