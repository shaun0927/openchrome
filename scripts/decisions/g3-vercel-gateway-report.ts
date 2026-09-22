import * as fs from 'fs';
import * as path from 'path';

const endpoint = 'https://ai-gateway.vercel.sh/v1/models';
const outDir = path.join('artifacts', 'decision', 'G3', 'vercel-gateway');
const jsonPath = path.join(outDir, 'models-report.json');
const mdPath = path.join(outDir, 'models-report.md');

interface VercelModel {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly owned_by?: unknown;
  readonly description?: unknown;
  readonly supported_specifications?: unknown;
  readonly modalities?: unknown;
  readonly pricing?: unknown;
}

interface ModelReport {
  readonly generated_at: string;
  readonly endpoint: string;
  readonly total_models: number;
  readonly jev_model: {
    readonly id: string;
    readonly name: string | null;
    readonly owned_by: string | null;
    readonly description_excerpt: string | null;
    readonly supported_specifications: unknown;
    readonly modalities: unknown;
    readonly pricing: unknown;
  } | null;
  readonly recommended_env: {
    readonly TYPESAFE_ENDPOINT: string;
    readonly TYPESAFE_MODEL: string;
    readonly TYPESAFE_PROTOCOL: 'openai-chat';
    readonly key_variable: 'AI_GATEWAY_API_KEY';
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function modelFrom(value: unknown): VercelModel | null {
  return isRecord(value) ? value : null;
}

function toReport(models: readonly VercelModel[]): ModelReport {
  const jev = models.find((model) => model.id === 'typesafe-ai/jev') ?? null;
  return {
    generated_at: new Date().toISOString(),
    endpoint,
    total_models: models.length,
    jev_model: jev ? {
      id: 'typesafe-ai/jev',
      name: stringOrNull(jev.name),
      owned_by: stringOrNull(jev.owned_by),
      description_excerpt: stringOrNull(jev.description)?.slice(0, 240) ?? null,
      supported_specifications: jev.supported_specifications ?? null,
      modalities: jev.modalities ?? null,
      pricing: jev.pricing ?? null,
    } : null,
    recommended_env: {
      TYPESAFE_ENDPOINT: 'https://ai-gateway.vercel.sh/v1/chat/completions',
      TYPESAFE_MODEL: 'typesafe-ai/jev',
      TYPESAFE_PROTOCOL: 'openai-chat',
      key_variable: 'AI_GATEWAY_API_KEY',
    },
  };
}

function markdown(report: ModelReport): string {
  const lines = [
    '# Vercel AI Gateway Jev model report',
    '',
    `Generated: ${report.generated_at}`,
    '',
    `Model endpoint: ${report.endpoint}`,
    '',
    `Total models returned: ${report.total_models}`,
    '',
    '## Jev',
    '',
  ];
  if (!report.jev_model) {
    lines.push('`typesafe-ai/jev` was not present in the model list.', '');
  } else {
    lines.push(
      `- id: \`${report.jev_model.id}\``,
      `- name: ${report.jev_model.name ?? '-'}`,
      `- owner: ${report.jev_model.owned_by ?? '-'}`,
      `- description: ${report.jev_model.description_excerpt ?? '-'}`,
      '',
    );
  }
  lines.push(
    '## Recommended environment',
    '',
    '```bash',
    `set TYPESAFE_ENDPOINT=${report.recommended_env.TYPESAFE_ENDPOINT}`,
    `set TYPESAFE_MODEL=${report.recommended_env.TYPESAFE_MODEL}`,
    `set TYPESAFE_PROTOCOL=${report.recommended_env.TYPESAFE_PROTOCOL}`,
    `set ${report.recommended_env.key_variable}=<vercel-ai-gateway-key>`,
    '```',
    '',
  );
  return `${lines.join('\n')}\n`;
}

async function main(): Promise<void> {
  const response = await fetch(endpoint);
  if (!response.ok) throw new Error(`model list request failed: ${response.status}`);
  const body: unknown = await response.json();
  if (!isRecord(body) || !Array.isArray(body.data)) throw new Error('model list response missing data array');
  const models = body.data.map(modelFrom).filter((model): model is VercelModel => model !== null);
  const report = toReport(models);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fs.writeFileSync(mdPath, markdown(report), 'utf8');
  console.log(JSON.stringify({ output: jsonPath, jev_model: report.jev_model?.id ?? null, total_models: report.total_models }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 2;
});
