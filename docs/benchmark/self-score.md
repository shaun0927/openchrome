---
doc_kind: explanation
status: canonical
version: 2026-07-21_v1
canonical_path: self
---

# Benchmark self-scoring (faithfulness NLI)

> Optional grading tier for benchmark extractions. Answers "did the extractor hallucinate?" without wiring a bespoke grader.

## Why

openchrome's benchmark harness records task success/failure, throughput, latency, and tokens. It does not grade whether extracted content is **faithful** to the source page. Users who compare openchrome against Playwright / Crawlee / browser-use on real-world extraction tasks have to bring their own grader — the harness has no contract for it.

This module adds a small contract — `FaithfulnessGrader` — modelled on the evaluation layer that ragas, deepeval, and Vectara HHEM converged on. A default `LexicalOverlapNliGrader` ships as a zero-dependency baseline; production runs can plug in a real NLI model behind the same interface.

## Contract

```ts
interface FaithfulnessGrader {
  readonly id: string;         // report id, e.g. "lexical-nli", "hhem"
  readonly label: string;      // human label
  grade(source: string, extracted: string):
    Promise<FaithfulnessScore> | FaithfulnessScore;
}

interface FaithfulnessScore {
  verdict: 'supported' | 'contradicted' | 'unsupported' | 'insufficient';
  score: number;               // 0..1
  details?: Record<string, unknown>;
}
```

Four verdicts:

- `supported` — every claim in `extracted` is present in `source`.
- `contradicted` — at least one claim contradicts `source`.
- `unsupported` — `extracted` contains claims not present in `source`.
- `insufficient` — the source is too small to grade fairly (guardrail).

## Report shape

`runSelfScore(grader, batch)` returns:

```json
{
  "grader": "lexical-nli",
  "graderLabel": "Lexical Overlap (baseline)",
  "generatedAt": "2026-07-21T09:00:00.000Z",
  "summary": {
    "total": 100,
    "supported": 72,
    "contradicted": 8,
    "unsupported": 15,
    "insufficient": 5,
    "meanScore": 0.78
  },
  "entries": [
    { "id": "task-01", "verdict": "supported", "score": 0.92 },
    { "id": "task-02", "verdict": "contradicted", "score": 0.11 }
  ]
}
```

The envelope is deliberately close to the trulens/giskard evaluation-report format, so downstream tools can consume both.

## Usage

```ts
import {
  LexicalOverlapNliGrader,
  runSelfScore,
} from 'openchrome/benchmark/self-score';

const grader = new LexicalOverlapNliGrader();
const report = await runSelfScore(grader, [
  { id: 'wiki-01', source: pageText, extracted: extractedMarkdown },
  { id: 'wiki-02', source: pageText2, extracted: extractedMarkdown2 },
]);

fs.writeFileSync('bench/self-score.json', JSON.stringify(report, null, 2));
```

To plug a stronger grader (HHEM, ragas, deepeval), implement `FaithfulnessGrader` in your own module and pass the instance to `runSelfScore`. No changes to the harness are needed.

## References

- ragas (Apache-2.0) — faithfulness metric shape.
- deepeval (Apache-2.0) — hallucination metric shape.
- Vectara HHEM (Apache-2.0) — factual consistency classifier.
- trulens / giskard — evaluation-report envelope inspiration.

Clean-room re-implementation. No source from the above was copied.
