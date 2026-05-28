# Online-Mind2Web Dataset

## License Attribution

The Online-Mind2Web dataset used in this benchmark is sourced from the Hugging Face repository [osunlp/Online-Mind2Web](https://huggingface.co/datasets/osunlp/Online-Mind2Web) and is licensed under the [Creative Commons Attribution 4.0 International (CC-BY 4.0)](https://creativecommons.org/licenses/by/4.0/) license. The dataset was created by Ge et al. as part of the "Online-Mind2Web: A Real-World Benchmark for Web Agents" research. The fixture file `fixtures/sample-10.json` contains 10 representative tasks hand-crafted to match the published schema (`task_id`, `website`, `task_description`, `reference_length`) and is provided here solely for deterministic CI testing under the terms of the CC-BY 4.0 license, with this attribution notice constituting the required credit. The pinned dataset commit used for registry purposes is `7ab0fc3b5e0420f6a74c4e0f0faebc1f3eddb0c1`; the full 300-task dataset can be fetched at runtime by setting `OPENCHROME_OM2W_FETCH=1`.

## Usage

```ts
import { loadOnlineMind2Web } from './loader';

// CI-safe fixture mode (10 tasks, no network):
const tasks = await loadOnlineMind2Web({ source: 'fixture' });

// Full HF dataset (requires OPENCHROME_OM2W_FETCH=1):
const tasks = await loadOnlineMind2Web({ source: 'hf', cacheDir: '/tmp/my-cache' });
```

## Schema

| Field | Type | Description |
|---|---|---|
| `task_id` | `string` | Unique task identifier |
| `website` | `string` | Target website domain or URL |
| `task_description` | `string` | Natural-language task description |
| `reference_length` | `number` | Number of steps in ground-truth trajectory |
