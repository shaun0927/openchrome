import * as fs from 'fs';
import * as path from 'path';

export interface StaleBenchmarkArtifact {
  file: string;
  expectedOpenChromeVersion: string;
  foundVersions: string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mentionsOpenChrome(value: unknown): boolean {
  return typeof value === 'string' && /openchrome/i.test(value);
}

function collectOpenChromeVersions(value: unknown, versions: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectOpenChromeVersions(item, versions);
    return;
  }
  if (!isObject(value)) return;

  const identityFields = [value.name, value.library, value.competitor, value.system, value.tool, value.adapter];
  const isOpenChromeRow = identityFields.some(mentionsOpenChrome);
  if (isOpenChromeRow && typeof value.version === 'string' && value.version.trim().length > 0) {
    versions.add(value.version.trim());
  }

  for (const nested of Object.values(value)) collectOpenChromeVersions(nested, versions);
}

export function findOpenChromeVersionPins(value: unknown): string[] {
  const versions = new Set<string>();
  collectOpenChromeVersions(value, versions);
  return Array.from(versions).sort();
}

export function auditBenchmarkResultArtifactFreshness(
  resultDir = path.join(process.cwd(), 'benchmark', 'results'),
  currentOpenChromeVersion = readCurrentOpenChromeVersion(),
): StaleBenchmarkArtifact[] {
  if (!fs.existsSync(resultDir)) return [];
  const stale: StaleBenchmarkArtifact[] = [];
  for (const entry of fs.readdirSync(resultDir).sort()) {
    if (!entry.endsWith('.json')) continue;
    const fullPath = path.join(resultDir, entry);
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    } catch {
      continue;
    }
    const foundVersions = findOpenChromeVersionPins(parsed).filter(
      (version) => version !== currentOpenChromeVersion && !/^(unknown|operator-pinned-runtime|idiomatic-script-only|TBD)/i.test(version),
    );
    if (foundVersions.length > 0) {
      stale.push({
        file: path.relative(process.cwd(), fullPath),
        expectedOpenChromeVersion: currentOpenChromeVersion,
        foundVersions,
      });
    }
  }
  return stale;
}

export function readCurrentOpenChromeVersion(packageJsonPath = path.join(process.cwd(), 'package.json')): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' && pkg.version.trim().length > 0 ? pkg.version.trim() : 'unknown';
  } catch {
    return 'unknown';
  }
}
