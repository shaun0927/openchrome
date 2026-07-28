import { execFile } from 'child_process';
import * as path from 'path';

const MANIFEST_TIMEOUT_MS = 30_000;
const MANIFEST_MAX_BUFFER = 8 * 1024 * 1024;

export class ToolManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolManifestError';
  }
}

export interface McpToolDefinition {
  name: string;
  inputSchema?: unknown;
  [key: string]: unknown;
}

export interface ToolDefinitionSource {
  listToolDefinitions(): Promise<McpToolDefinition[]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseRegisteredToolManifest(output: string): McpToolDefinition[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (err) {
    throw new ToolManifestError(
      `Registered tool manifest is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!Array.isArray(parsed)) {
    throw new ToolManifestError('Registered tool manifest must be a JSON array.');
  }

  return parsed.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.name !== 'string' || entry.name.length === 0) {
      throw new ToolManifestError(`Registered tool manifest entry ${index} is malformed.`);
    }
    return entry as McpToolDefinition;
  });
}

function stderrTail(stderr: string): string {
  return stderr.trim().split('\n').slice(-8).join('\n');
}

export class RegisteredToolManifestClient implements ToolDefinitionSource {
  async listToolDefinitions(): Promise<McpToolDefinition[]> {
    const serveEntry = path.join(__dirname, '..', '..', 'index.js');
    return new Promise<McpToolDefinition[]>((resolve, reject) => {
      execFile(
        process.execPath,
        [serveEntry, 'serve', '--introspect-tools-list'],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            OPENCHROME_PPID_WATCH: '0',
            OPENCHROME_UPDATE_CHECK: '0',
          },
          maxBuffer: MANIFEST_MAX_BUFFER,
          timeout: MANIFEST_TIMEOUT_MS,
        },
        (error, stdout, stderr) => {
          if (error) {
            const details = stderrTail(stderr);
            reject(new ToolManifestError(
              `Failed to read the registered tool manifest: ${error.message}${details ? `\n${details}` : ''}`,
            ));
            return;
          }
          try {
            resolve(parseRegisteredToolManifest(stdout));
          } catch (err) {
            reject(err);
          }
        },
      );
    });
  }
}
