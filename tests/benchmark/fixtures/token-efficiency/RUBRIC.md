# Token-Efficiency Fixture Rubric

Part of the Token Efficiency axis (#1256, Epic #1254). This rubric is committed
**before** any measurement run, so the metric cannot be retro-fitted to a result.

## Ground-truth fields

Each fixture ships a `GroundTruthSpec` with **at least 12 fields**
(`MIN_GROUND_TRUTH_FIELDS` in `tests/benchmark/token-efficiency.ts`). Fewer
fields quantize the retention metric into uselessly coarse buckets — a 3-field
spec resolves only to `{0, 33, 67, 100}%`.

Fields span four categories so retention reflects the whole page, not one
corner of it:

- **structured data** — title, price, sku, brand, etc.
- **primary content** — headline, body summary, author, date
- **navigation / interactive** — primary CTA, breadcrumb, key link label
- **metadata** — canonical url, category, language

## "Present" — the matching rule

A field is **retained** when the **normalized** extracted value equals the
**normalized** expected value, where `normalizeValue` (in
`tests/benchmark/token-efficiency.ts`) applies: strip markup → collapse
whitespace → trim → lowercase.

Critically: retention is scored against a library's **structured, field-keyed
extraction** — never a substring match against a raw blob. A tool that dumps
raw HTML cannot score 100% retention just because every value exists somewhere
in the dump. `computeRetention` only accepts a `Record<string, string|null>`,
which enforces this by construction.

## Starter corpus

The initial corpus (`corpus.ts`) is a small **structured** starter set — three
archetypes (e-commerce, news, docs), each built so a deterministic extractor
can resolve the fields, establishing the baseline measurement path. The full
50-fixture corpus of real-page snapshots, and the per-library extraction
adapters, are later work units of #1256.
