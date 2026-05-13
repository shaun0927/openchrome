/**
 * File Upload Tool - Upload files to file input elements
 */

import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getGlobalConfig } from '../config/global';
import { DEFAULT_FILE_UPLOAD_TEMP_DIR } from '../config/defaults';
import { getSessionManager } from '../session-manager';
import { withTimeout } from '../utils/with-timeout';

const OPENCHROME_FILE_UPLOAD_ROOTS_ENV = 'OPENCHROME_FILE_UPLOAD_ROOTS';
const OPENCHROME_FILE_UPLOAD_TEMP_DIR_ENV = 'OPENCHROME_FILE_UPLOAD_TEMP_DIR';

const SENSITIVE_PATH_SEGMENTS = ['.ssh', '.gnupg', '.aws', '.env', 'id_rsa', 'id_ed25519', '.npmrc'];

interface PathLike {
  sep: string;
  delimiter: string;
  basename(path: string): string;
  isAbsolute(path: string): boolean;
  join(...paths: string[]): string;
  relative(from: string, to: string): string;
  resolve(...paths: string[]): string;
}

export interface UploadRootPolicyOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  configuredRoots?: string[];
  pathModule?: PathLike;
  tempUploadDir?: string;
}

export interface ValidateUploadPathOptions extends UploadRootPolicyOptions {
  ensureDefaultTempRoot?: boolean;
  /** Pre-resolved real paths of allowed upload roots. When provided, validateUploadPath
   *  skips its own root resolution (no fs.mkdir / fs.realpath per call), so callers
   *  validating many files in one request only pay that cost once. */
  resolvedAllowedRoots?: string[];
}

export interface ValidatedUploadFile {
  originalPath: string;
  resolvedPath: string;
  realPath: string;
  name: string;
  size: number;
}

export interface UploadPathValidationResult {
  ok: boolean;
  file?: ValidatedUploadFile;
  error?: string;
}

const definition: MCPToolDefinition = {
  name: 'file_upload',
  description: 'Upload files to a file input element on the page. Pass intent="..." (≤120 chars) to label this action in audit logs.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'string',
        description: 'Tab ID to upload files to',
      },
      selector: {
        type: 'string',
        description: 'CSS selector for the file input element',
      },
      filePaths: {
        type: 'array',
        items: { type: 'string' },
        description: 'File paths to upload. Paths must resolve under configured file_upload roots.',
      },
      intent: {
        type: 'string',
        description: 'Human-readable label for this action in audit logs (≤120 chars)',
        maxLength: 120,
      },
    },
    required: ['tabId', 'selector', 'filePaths'],
  },
};

export function parseUploadRootsEnv(raw: string | undefined, delimiter: string = path.delimiter): string[] {
  if (!raw) return [];
  return raw
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function getDefaultUploadTempDir(
  env: NodeJS.ProcessEnv = process.env,
  pathModule: PathLike = path
): string {
  return pathModule.resolve(expandHomePath(env[OPENCHROME_FILE_UPLOAD_TEMP_DIR_ENV] || DEFAULT_FILE_UPLOAD_TEMP_DIR, pathModule));
}

export function getConfiguredUploadRoots(configuredRoots?: string[]): string[] {
  const securityConfig = getGlobalConfig().security;
  return configuredRoots ?? securityConfig?.file_upload_roots ?? [];
}

export function getUploadRootPolicy(options: UploadRootPolicyOptions = {}): string[] {
  const pathModule = options.pathModule ?? path;
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const tempUploadDir = options.tempUploadDir ?? getDefaultUploadTempDir(env, pathModule);
  const configuredRoots = options.configuredRoots ?? getConfiguredUploadRoots();
  const envRoots = parseUploadRootsEnv(env[OPENCHROME_FILE_UPLOAD_ROOTS_ENV], pathModule.delimiter);

  return [cwd, tempUploadDir, ...configuredRoots, ...envRoots]
    .map((root) => root.trim())
    .filter((root) => root.length > 0)
    .map((root) => expandHomePath(root, pathModule))
    .map((root) => pathModule.resolve(root));
}

export function expandHomePath(filePath: string, pathModule: PathLike = path): string {
  if (filePath === '~') {
    return os.homedir();
  }
  if (filePath.startsWith(`~${pathModule.sep}`) || filePath.startsWith('~/') || filePath.startsWith('~\\')) {
    return pathModule.join(os.homedir(), filePath.slice(2));
  }
  if (process.platform === 'win32' && filePath.toLowerCase().startsWith('%userprofile%')) {
    const rest = filePath.slice('%USERPROFILE%'.length).replace(/^[/\\]+/, '');
    return pathModule.join(os.homedir(), rest);
  }
  return filePath;
}

export function resolveCandidateUploadPath(filePath: string, pathModule: PathLike = path): string {
  return pathModule.resolve(expandHomePath(filePath, pathModule));
}

export function isPathInsideRoot(
  candidateRealPath: string,
  rootRealPath: string,
  pathModule: PathLike = path,
  caseSensitive = process.platform !== 'win32'
): boolean {
  const candidate = caseSensitive ? candidateRealPath : candidateRealPath.toLowerCase();
  const root = caseSensitive ? rootRealPath : rootRealPath.toLowerCase();
  const relative = pathModule.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !pathModule.isAbsolute(relative));
}

export function hasSensitivePathSegment(filePath: string, pathModule: PathLike = path): boolean {
  const normalizedPath = pathModule.resolve(filePath);
  const pathSegments = normalizedPath.toLowerCase().split(/[\\/]+/);
  return SENSITIVE_PATH_SEGMENTS.some((segment) => pathSegments.includes(segment));
}

export async function resolveAllowedUploadRoots(options: ValidateUploadPathOptions = {}): Promise<string[]> {
  if (options.ensureDefaultTempRoot !== false) {
    const pathModule = options.pathModule ?? path;
    const env = options.env ?? process.env;
    const tempUploadDir = options.tempUploadDir ?? getDefaultUploadTempDir(env, pathModule);
    try {
      await fs.mkdir(tempUploadDir, { recursive: true });
    } catch {
      // If we cannot create the temp upload directory (e.g. read-only filesystem,
      // permission denied), fall through. The directory simply will not become a
      // valid root via realpath() below; uploads from other configured roots still work.
    }
  }

  const roots = getUploadRootPolicy(options);
  const realRoots: string[] = [];
  const seen = new Set<string>();

  for (const root of roots) {
    try {
      const realRoot = await fs.realpath(root);
      const key = process.platform === 'win32' ? realRoot.toLowerCase() : realRoot;
      if (!seen.has(key)) {
        realRoots.push(realRoot);
        seen.add(key);
      }
    } catch {
      // Non-existent configured roots are not used for allowlist decisions.
    }
  }

  return realRoots;
}

export async function validateUploadPath(
  filePath: string,
  options: ValidateUploadPathOptions = {}
): Promise<UploadPathValidationResult> {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    return { ok: false, error: 'Error: Upload path must be a non-empty string' };
  }

  const pathModule = options.pathModule ?? path;
  const resolvedPath = resolveCandidateUploadPath(filePath, pathModule);

  let realPath: string;
  try {
    realPath = await fs.realpath(resolvedPath);
  } catch {
    return { ok: false, error: 'Error: Upload file is not accessible' };
  }

  const allowedRoots = options.resolvedAllowedRoots ?? await resolveAllowedUploadRoots(options);
  const isAllowed = allowedRoots.some((root) => isPathInsideRoot(realPath, root, pathModule));
  if (!isAllowed) {
    return { ok: false, error: 'Error: Upload path is outside allowed upload roots' };
  }

  if (hasSensitivePathSegment(realPath, pathModule)) {
    return { ok: false, error: 'Error: Upload blocked by sensitive file policy' };
  }

  let stats;
  try {
    stats = await fs.stat(realPath);
  } catch {
    return { ok: false, error: 'Error: Upload file is not accessible' };
  }

  if (!stats.isFile()) {
    return { ok: false, error: 'Error: Upload path is not a file' };
  }

  return {
    ok: true,
    file: {
      originalPath: filePath,
      resolvedPath,
      realPath,
      name: pathModule.basename(realPath),
      size: stats.size,
    },
  };
}

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>
): Promise<MCPResult> => {
  const tabId = args.tabId as string;
  const selector = args.selector as string;
  const filePaths = args.filePaths as string[];
  const intent = args.intent as string | undefined;

  // Validate intent when provided — use typeof guard for null-safety
  if (typeof intent === 'string') {
    if (intent === '') {
      return {
        content: [{ type: 'text', text: 'INVALID_INTENT: intent must not be an empty string' }],
        isError: true,
      };
    }
    if (intent.length > 120) {
      return {
        content: [{ type: 'text', text: `INVALID_INTENT: intent exceeds 120 characters (got ${intent.length})` }],
        isError: true,
      };
    }
  }

  const sessionManager = getSessionManager();

  if (!tabId) {
    return {
      content: [{ type: 'text', text: 'Error: tabId is required' }],
      isError: true,
    };
  }

  if (!selector) {
    return {
      content: [{ type: 'text', text: 'Error: selector is required' }],
      isError: true,
    };
  }

  if (!filePaths || !Array.isArray(filePaths) || filePaths.length === 0) {
    return {
      content: [{ type: 'text', text: 'Error: filePaths array is required and must not be empty' }],
      isError: true,
    };
  }

  try {
    const page = await sessionManager.getPage(sessionId, tabId, undefined, 'file_upload');
    if (!page) {
      return {
        content: [{ type: 'text', text: `Error: Tab ${tabId} not found` }],
        isError: true,
      };
    }

    // Resolve and validate file paths against explicit upload roots before browser upload.
    // Resolve allowed roots once per request to avoid redundant fs.mkdir/fs.realpath
    // calls when validating multiple files.
    const resolvedAllowedRoots = await resolveAllowedUploadRoots();
    const resolvedPaths: string[] = [];
    const fileInfo: Array<{ name: string; size: number }> = [];

    for (const filePath of filePaths) {
      const validation = await validateUploadPath(filePath, { resolvedAllowedRoots });
      if (!validation.ok || !validation.file) {
        return {
          content: [{ type: 'text', text: validation.error ?? 'Error: Upload path is not allowed' }],
          isError: true,
        };
      }

      resolvedPaths.push(validation.file.realPath);
      fileInfo.push({
        name: validation.file.name,
        size: validation.file.size,
      });
    }

    // Find the file input element
    const fileInput = await page.$(selector);
    if (!fileInput) {
      return {
        content: [{ type: 'text', text: `Error: File input not found: ${selector}` }],
        isError: true,
      };
    }

    // Verify it's a file input
    const isFileInput = await withTimeout(page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return el && el.tagName.toLowerCase() === 'input' && (el as HTMLInputElement).type === 'file';
    }, selector), 10000, 'file_upload');

    if (!isFileInput) {
      return {
        content: [
          {
            type: 'text',
            text: `Error: Element at ${selector} is not a file input`,
          },
        ],
        isError: true,
      };
    }

    // Check if input accepts multiple files
    const acceptsMultiple = await withTimeout(page.evaluate((sel) => {
      const el = document.querySelector(sel) as HTMLInputElement;
      return el?.multiple ?? false;
    }, selector), 10000, 'file_upload');

    if (resolvedPaths.length > 1 && !acceptsMultiple) {
      return {
        content: [
          {
            type: 'text',
            text: 'Error: File input does not accept multiple files, but multiple paths provided',
          },
        ],
        isError: true,
      };
    }

    // Upload files - cast to HTMLInputElement handle
    const inputHandle = fileInput as import('puppeteer-core').ElementHandle<HTMLInputElement>;
    await inputHandle.uploadFile(...resolvedPaths);

    // Get total size
    const totalSize = fileInfo.reduce((sum, f) => sum + f.size, 0);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            action: 'file_upload',
            selector,
            files: fileInfo,
            count: fileInfo.length,
            totalSizeKB: Math.round(totalSize / 1024),
            message: `Uploaded ${fileInfo.length} file(s): ${fileInfo.map((f) => f.name).join(', ')}`,
          }),
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `File upload error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
};

export function registerFileUploadTool(server: MCPServer): void {
  server.registerTool('file_upload', handler, definition);
}
