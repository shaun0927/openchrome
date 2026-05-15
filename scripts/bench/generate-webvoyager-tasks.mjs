#!/usr/bin/env node
/**
 * Generate WebVoyager task files for the Agent Task Success axis (#1257).
 *
 * Emits TypeScript task files under
 * `tests/benchmark/webvoyager/tasks/task-NN-<slug>.ts`. Each generated task
 * is shipped with `pending: true` until a transcript is recorded — the
 * mock runner skips pending tasks and the baseline.json only lists tasks
 * whose transcript has been frozen. This keeps the corpus honest: structural
 * schema validation passes today, real LLM-driven measurements record the
 * transcripts in the next session.
 *
 * Run:
 *
 *   node scripts/bench/generate-webvoyager-tasks.mjs
 *
 * Sources are license-safe / low-volatility: RFC-2606 example domains,
 * Wikipedia article facts that have been stable for years, MDN reference
 * pages, IETF RFCs, WHATWG/W3C specs, TC39 ECMAScript spec, Rust std docs,
 * Python docs. Volatile sources (live weather APIs, search engines, social
 * sites) are deliberately excluded so site drift doesn't pollute the
 * benchmark headline.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TASKS_DIR = path.join(REPO_ROOT, 'tests', 'benchmark', 'webvoyager', 'tasks');

/**
 * Manifest of 42 new tasks (existing 18 → 60 total). Each entry generates one
 * task file. The `volatile` flag is for the per-source-volatility annotation
 * recorded in the rationale; the actual `volatile` task tag in the bucket
 * sense uses a name suffix (`-volatile`) that the runner inspects.
 *
 * Keep this list license-safe: RFC-2606 example domains, public reference
 * docs (RFC, W3C, WHATWG, TC39), public Wikipedia article facts, MDN.
 */
const TASKS = [
  // ---- example domains (RFC-2606 reserved) — smoke ----
  { slug: 'example-com-h1', url: 'https://example.com', text: 'Example Domain', label: 'h1 contains Example Domain on example.com' },
  { slug: 'example-org-h1', url: 'https://example.org', text: 'Example Domain', label: 'h1 contains Example Domain on example.org' },
  { slug: 'example-net-h1', url: 'https://example.net', text: 'Example Domain', label: 'h1 contains Example Domain on example.net' },

  // ---- Wikipedia (high-stability article facts) ----
  { slug: 'wikipedia-light-speed', url: 'https://en.wikipedia.org/wiki/Speed_of_light', text: '299792458', label: 'Speed-of-light article cites 299,792,458 m/s' },
  { slug: 'wikipedia-everest', url: 'https://en.wikipedia.org/wiki/Mount_Everest', text: '8,848', label: 'Mount Everest height cited as 8,848 m' },
  { slug: 'wikipedia-mariana-trench', url: 'https://en.wikipedia.org/wiki/Mariana_Trench', text: 'deepest', label: 'Mariana Trench described as deepest oceanic trench' },
  { slug: 'wikipedia-eiffel-tower', url: 'https://en.wikipedia.org/wiki/Eiffel_Tower', text: 'Paris', label: 'Eiffel Tower located in Paris' },
  { slug: 'wikipedia-statue-of-liberty', url: 'https://en.wikipedia.org/wiki/Statue_of_Liberty', text: 'New York', label: 'Statue of Liberty located in New York' },
  { slug: 'wikipedia-internet-protocol', url: 'https://en.wikipedia.org/wiki/Internet_Protocol', text: 'datagram', label: 'Internet Protocol article mentions datagram' },
  { slug: 'wikipedia-ascii', url: 'https://en.wikipedia.org/wiki/ASCII', text: '128', label: 'ASCII character set described as 128 code points' },
  { slug: 'wikipedia-pi', url: 'https://en.wikipedia.org/wiki/Pi', text: '3.14', label: 'Pi article cites 3.14...' },
  { slug: 'wikipedia-utf8', url: 'https://en.wikipedia.org/wiki/UTF-8', text: 'variable-width', label: 'UTF-8 described as variable-width' },
  { slug: 'wikipedia-tim-berners-lee', url: 'https://en.wikipedia.org/wiki/Tim_Berners-Lee', text: 'World Wide Web', label: 'Tim Berners-Lee credited with inventing the World Wide Web' },
  { slug: 'wikipedia-rfc-editor', url: 'https://en.wikipedia.org/wiki/Request_for_Comments', text: 'IETF', label: 'RFC document series associated with IETF' },

  // ---- RFCs (immutable once published) ----
  { slug: 'rfc-2606-reserved', url: 'https://www.rfc-editor.org/rfc/rfc2606', text: 'example', label: 'RFC 2606 lists example as a reserved TLD' },
  { slug: 'rfc-2119-keywords', url: 'https://www.rfc-editor.org/rfc/rfc2119', text: 'MUST', label: 'RFC 2119 defines MUST keyword' },
  { slug: 'rfc-8259-json', url: 'https://www.rfc-editor.org/rfc/rfc8259', text: 'JavaScript Object Notation', label: 'RFC 8259 titled JavaScript Object Notation' },
  { slug: 'rfc-9110-http', url: 'https://www.rfc-editor.org/rfc/rfc9110', text: 'HTTP Semantics', label: 'RFC 9110 titled HTTP Semantics' },
  { slug: 'rfc-7231-http-methods', url: 'https://www.rfc-editor.org/rfc/rfc7231', text: 'method', label: 'RFC 7231 defines HTTP methods' },
  { slug: 'rfc-3986-uri', url: 'https://www.rfc-editor.org/rfc/rfc3986', text: 'Uniform Resource Identifier', label: 'RFC 3986 defines URI syntax' },
  { slug: 'rfc-5321-smtp', url: 'https://www.rfc-editor.org/rfc/rfc5321', text: 'Simple Mail Transfer Protocol', label: 'RFC 5321 defines SMTP' },
  { slug: 'rfc-6749-oauth', url: 'https://www.rfc-editor.org/rfc/rfc6749', text: 'OAuth 2.0', label: 'RFC 6749 defines OAuth 2.0' },

  // ---- MDN (reference pages, stable URLs) ----
  { slug: 'mdn-fetch', url: 'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API', text: 'Fetch API', label: 'MDN Fetch API reference' },
  { slug: 'mdn-array-map', url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/map', text: 'map', label: 'MDN Array.prototype.map reference' },
  { slug: 'mdn-array-filter', url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/filter', text: 'filter', label: 'MDN Array.prototype.filter reference' },
  { slug: 'mdn-promise-then', url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/then', text: 'then', label: 'MDN Promise.prototype.then reference' },
  { slug: 'mdn-async-await', url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/await', text: 'await', label: 'MDN await operator reference' },
  { slug: 'mdn-css-grid', url: 'https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_grid_layout', text: 'grid', label: 'MDN CSS Grid Layout reference' },
  { slug: 'mdn-css-flexbox', url: 'https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_flexible_box_layout', text: 'flex', label: 'MDN CSS Flexbox reference' },
  { slug: 'mdn-html-img', url: 'https://developer.mozilla.org/en-US/docs/Web/HTML/Element/img', text: 'img', label: 'MDN HTML img element reference' },

  // ---- TC39 / ECMAScript ----
  { slug: 'tc39-ecma262-syntax', url: 'https://tc39.es/ecma262/', text: 'ECMAScript', label: 'TC39 ECMAScript spec home' },
  { slug: 'tc39-proposals', url: 'https://github.com/tc39/proposals', text: 'proposals', label: 'TC39 proposals repo' },

  // ---- W3C / WHATWG ----
  { slug: 'whatwg-html-spec', url: 'https://html.spec.whatwg.org/', text: 'HTML', label: 'WHATWG HTML living standard' },
  { slug: 'whatwg-fetch-spec', url: 'https://fetch.spec.whatwg.org/', text: 'Fetch', label: 'WHATWG Fetch standard' },
  { slug: 'w3c-css-spec', url: 'https://www.w3.org/Style/CSS/', text: 'CSS', label: 'W3C CSS home' },

  // ---- Rust std ----
  { slug: 'rust-string-trim', url: 'https://doc.rust-lang.org/std/string/struct.String.html', text: 'String', label: 'Rust std::string::String docs' },
  { slug: 'rust-option-enum', url: 'https://doc.rust-lang.org/std/option/enum.Option.html', text: 'Option', label: 'Rust std::option::Option docs' },
  { slug: 'rust-result-enum', url: 'https://doc.rust-lang.org/std/result/enum.Result.html', text: 'Result', label: 'Rust std::result::Result docs' },
  { slug: 'rust-vec', url: 'https://doc.rust-lang.org/std/vec/struct.Vec.html', text: 'Vec', label: 'Rust std::vec::Vec docs' },

  // ---- Python docs ----
  { slug: 'python-len-builtin', url: 'https://docs.python.org/3/library/functions.html', text: 'len', label: 'Python built-in functions reference' },
  { slug: 'python-list-stdtypes', url: 'https://docs.python.org/3/library/stdtypes.html', text: 'list', label: 'Python stdtypes reference (list)' },
  { slug: 'python-dict-stdtypes', url: 'https://docs.python.org/3/library/stdtypes.html', text: 'dict', label: 'Python stdtypes reference (dict)' },
  { slug: 'python-pep-8', url: 'https://peps.python.org/pep-0008/', text: 'Style Guide', label: 'PEP 8 Style Guide' },
];

const STARTING_INDEX = 19; // existing tasks are task-01 .. task-18

function pad(n) {
  return String(n).padStart(2, '0');
}

function buildTaskTs(task, index) {
  const name = `task-${pad(index)}-${task.slug}`;
  // Escape the URL for the regex pattern (escape dot + slashes).
  const escapedUrl = task.url
    .replace(/[.\\?+*$^()[\]{}|]/g, (m) => `\\\\${m}`)
    .replace(/\//g, '\\\\/');
  const escapedText = task.text.replace(/[\\'`]/g, '\\$&');
  const rationale = `${task.label}. Source is a low-volatility public reference page (license-safe). Task ships as pending until the next-session real-LLM run records a transcript.`;
  return `import type { WebVoyagerTask } from '../types';

const task: WebVoyagerTask = {
  name: '${name}',
  instruction: 'Visit ${task.url} and confirm the page mentions "${task.text}".',
  contract: {
    postconditions: {
      kind: 'and',
      children: [
        { kind: 'url', pattern: '^${escapedUrl}' },
        { kind: 'dom_text', selector: 'body', contains: '${escapedText}' },
      ],
    },
  },
  timeout_ms: 90_000,
  pending: true,
  rationale:
    '${rationale}',
};

export default task;
`;
}

function main() {
  let written = 0;
  for (let i = 0; i < TASKS.length; i++) {
    const index = STARTING_INDEX + i;
    const task = TASKS[i];
    const name = `task-${pad(index)}-${task.slug}`;
    const filename = `${name}.ts`;
    const filepath = path.join(TASKS_DIR, filename);
    if (fs.existsSync(filepath)) {
      process.stderr.write(`Skip (already exists): ${filename}\n`);
      continue;
    }
    fs.writeFileSync(filepath, buildTaskTs(task, index));
    written += 1;
    process.stderr.write(`Wrote ${filename}\n`);
  }
  process.stderr.write(`\nGenerated ${written} new task files (existing kept). Target total: ${STARTING_INDEX - 1 + TASKS.length}.\n`);
}

main();
