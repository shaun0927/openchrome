import type { WebVoyagerTask } from '../types';

const task: WebVoyagerTask = {
  name: 'task-56-rust-result-enum',
  instruction: 'Visit https://doc.rust-lang.org/std/result/enum.Result.html and confirm the page mentions "Result".',
  contract: {
    postconditions: {
      kind: 'and',
      children: [
        { kind: 'url', pattern: '^https:\\/\\/doc\\.rust-lang\\.org\\/std\\/result\\/enum\\.Result\\.html' },
        { kind: 'dom_text', selector: 'body', contains: 'Result' },
      ],
    },
  },
  timeout_ms: 90_000,
  pending: true,
  rationale:
    'Rust std::result::Result docs. Source is a low-volatility public reference page (license-safe). Task ships as pending until the next-session real-LLM run records a transcript.',
};

export default task;
