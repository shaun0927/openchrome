import { getSessionManager, _resetSessionManagerForTesting } from '../../src/session-manager';

describe('StorageState CLI wiring via getSessionManager()', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    _resetSessionManagerForTesting();
  });

  afterEach(() => {
    _resetSessionManagerForTesting();
    process.env = originalEnv;
  });

  it('should enable storage state when OC_PERSIST_STORAGE is set', () => {
    process.env.OC_PERSIST_STORAGE = '1';
    const sm = getSessionManager();
    const config = (sm as any).config;
    expect(config.storageState?.enabled).toBe(true);
  });

  it('should use custom storage dir from OC_STORAGE_DIR', () => {
    process.env.OC_PERSIST_STORAGE = '1';
    process.env.OC_STORAGE_DIR = '/custom/path';
    const sm = getSessionManager();
    const config = (sm as any).config;
    expect(config.storageState?.enabled).toBe(true);
    expect(config.storageState?.dir).toBe('/custom/path');
  });

  it('should not enable storage state when env var is not set', () => {
    delete process.env.OC_PERSIST_STORAGE;
    const sm = getSessionManager();
    const config = (sm as any).config;
    expect(config.storageState?.enabled ?? false).toBe(false);
  });
});
