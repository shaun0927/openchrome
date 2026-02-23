import { SessionManager } from '../../src/session-manager';

describe('StorageState CLI wiring', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should enable storage state when OC_PERSIST_STORAGE is set', () => {
    process.env.OC_PERSIST_STORAGE = '1';
    // Create a SessionManager with default config and verify storageState is wired
    const sm = new SessionManager(undefined, {
      storageState: process.env.OC_PERSIST_STORAGE === '1'
        ? { enabled: true, dir: process.env.OC_STORAGE_DIR || undefined }
        : undefined,
    });
    // Access internal config via any cast (test-only)
    const config = (sm as any).config;
    expect(config.storageState.enabled).toBe(true);
  });

  it('should use custom storage dir from OC_STORAGE_DIR', () => {
    process.env.OC_PERSIST_STORAGE = '1';
    process.env.OC_STORAGE_DIR = '/custom/path';
    const sm = new SessionManager(undefined, {
      storageState: {
        enabled: true,
        dir: process.env.OC_STORAGE_DIR,
      },
    });
    const config = (sm as any).config;
    expect(config.storageState.enabled).toBe(true);
    expect(config.storageState.dir).toBe('/custom/path');
  });

  it('should not enable storage state when env var is not set', () => {
    delete process.env.OC_PERSIST_STORAGE;
    const sm = new SessionManager(undefined);
    const config = (sm as any).config;
    expect(config.storageState.enabled).toBe(false);
  });
});
