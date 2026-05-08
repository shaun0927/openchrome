import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  getUploadRootPolicy,
  isPathInsideRoot,
  parseUploadRootsEnv,
  validateUploadPath,
} from '../../src/tools/file-upload';

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch {
    return false;
  }
}

describe('file_upload path validation', () => {
  let tmpDir: string;
  let uploadRoot: string;
  let tempRoot: string;
  let outsideRoot: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-upload-validation-'));
    uploadRoot = path.join(tmpDir, 'uploads');
    tempRoot = path.join(tmpDir, 'temp-uploads');
    outsideRoot = path.join(tmpDir, 'outside');
    await fs.mkdir(uploadRoot, { recursive: true });
    await fs.mkdir(tempRoot, { recursive: true });
    await fs.mkdir(outsideRoot, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const options = () => ({
    cwd: uploadRoot,
    configuredRoots: [],
    tempUploadDir: tempRoot,
    ensureDefaultTempRoot: false,
    env: {},
  });

  test('allows a regular file under an upload root', async () => {
    const allowedFile = path.join(uploadRoot, 'allowed.txt');
    await fs.writeFile(allowedFile, 'ok');

    const result = await validateUploadPath(allowedFile, options());

    expect(result.ok).toBe(true);
    expect(result.file).toEqual(expect.objectContaining({
      name: 'allowed.txt',
      size: 2,
    }));
  });

  test('denies an absolute path outside upload roots without echoing the path', async () => {
    const outsideFile = path.join(outsideRoot, 'secret.txt');
    await fs.writeFile(outsideFile, 'no');

    const result = await validateUploadPath(outsideFile, options());

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Error: Upload path is outside allowed upload roots');
    expect(result.error).not.toContain(outsideFile);
  });

  test('denies traversal that resolves outside upload roots', async () => {
    const outsideFile = path.join(outsideRoot, 'traversed.txt');
    await fs.writeFile(outsideFile, 'no');
    const traversalPath = path.join(uploadRoot, '..', 'outside', 'traversed.txt');

    const result = await validateUploadPath(traversalPath, options());

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Error: Upload path is outside allowed upload roots');
  });

  test('denies symlink escape after realpath resolution', async () => {
    const outsideFile = path.join(outsideRoot, 'linked-secret.txt');
    const symlinkPath = path.join(uploadRoot, 'link-to-secret.txt');
    await fs.writeFile(outsideFile, 'no');

    try {
      await fs.symlink(outsideFile, symlinkPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        return;
      }
      throw error;
    }

    const result = await validateUploadPath(symlinkPath, options());

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Error: Upload path is outside allowed upload roots');
  });

  test('keeps sensitive-path blacklist behavior after allowlist enforcement', async () => {
    const sshDir = path.join(uploadRoot, '.ssh');
    const sensitiveFile = path.join(sshDir, 'id_rsa');
    await fs.mkdir(sshDir, { recursive: true });
    await fs.writeFile(sensitiveFile, 'private');

    const result = await validateUploadPath(sensitiveFile, options());

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Error: Upload blocked by sensitive file policy');
  });

  test('rejects inaccessible candidates instead of falling back to prefix checks', async () => {
    const missingFile = path.join(uploadRoot, 'missing.txt');

    const result = await validateUploadPath(missingFile, options());

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Error: Upload file is not accessible');
  });

  test('uses configured environment upload roots in addition to defaults', async () => {
    const envRoot = path.join(tmpDir, 'env-root');
    const envFile = path.join(envRoot, 'from-env.txt');
    await fs.mkdir(envRoot, { recursive: true });
    await fs.writeFile(envFile, 'env');

    const result = await validateUploadPath(envFile, {
      ...options(),
      env: { OPENCHROME_FILE_UPLOAD_ROOTS: envRoot },
    });

    expect(result.ok).toBe(true);
    expect(result.file?.name).toBe('from-env.txt');
  });

  test('default policy includes cwd and the configured temp upload directory', async () => {
    const roots = getUploadRootPolicy({
      cwd: uploadRoot,
      configuredRoots: [],
      env: { OPENCHROME_FILE_UPLOAD_TEMP_DIR: tempRoot },
    });

    expect(roots).toContain(path.resolve(uploadRoot));
    expect(roots).toContain(path.resolve(tempRoot));
  });

  test('expands home-relative temp upload directory overrides', () => {
    const roots = getUploadRootPolicy({
      cwd: uploadRoot,
      configuredRoots: [],
      env: { OPENCHROME_FILE_UPLOAD_TEMP_DIR: '~/openchrome-upload-root-test' },
    });

    expect(roots).toContain(path.resolve(os.homedir(), 'openchrome-upload-root-test'));
  });

  test('uses direct security.file_upload_roots configuration', async () => {
    const configuredRoot = path.join(tmpDir, 'configured-root');
    const configuredFile = path.join(configuredRoot, 'from-config.txt');
    await fs.mkdir(configuredRoot, { recursive: true });
    await fs.writeFile(configuredFile, 'configured');

    const result = await validateUploadPath(configuredFile, {
      ...options(),
      configuredRoots: [configuredRoot],
    });

    expect(result.ok).toBe(true);
    expect(result.file?.name).toBe('from-config.txt');
  });

  test('parses root lists with the platform delimiter', () => {
    expect(parseUploadRootsEnv('/one:/two', ':')).toEqual(['/one', '/two']);
    expect(parseUploadRootsEnv('C:\\one;D:\\two', ';')).toEqual(['C:\\one', 'D:\\two']);
  });

  test('handles cross-platform containment boundaries', () => {
    expect(isPathInsideRoot('C:\\Uploads\\file.txt', 'c:\\uploads', path.win32, false)).toBe(true);
    expect(isPathInsideRoot('C:\\Uploads-other\\file.txt', 'c:\\uploads', path.win32, false)).toBe(false);
    expect(isPathInsideRoot('/tmp/uploads/file.txt', '/tmp/uploads', path.posix, true)).toBe(true);
    expect(isPathInsideRoot('/tmp/uploads-other/file.txt', '/tmp/uploads', path.posix, true)).toBe(false);
  });

  test('creates the default temp upload root when validation runs', async () => {
    const defaultTempRoot = path.join(tmpDir, 'created-temp-root');
    const allowedFile = path.join(uploadRoot, 'allowed.txt');
    await fs.writeFile(allowedFile, 'ok');
    expect(await pathExists(defaultTempRoot)).toBe(false);

    const result = await validateUploadPath(allowedFile, {
      cwd: uploadRoot,
      configuredRoots: [],
      tempUploadDir: defaultTempRoot,
      env: {},
    });

    expect(result.ok).toBe(true);
    expect(await pathExists(defaultTempRoot)).toBe(true);
  });
});
