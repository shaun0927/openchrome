import { getBuildInfo } from '../../cli/build-info';

describe('CLI build provenance', () => {
  const original = { ...process.env };

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in original)) delete process.env[key];
    }
    Object.assign(process.env, original);
  });

  test('uses embedded build metadata when present', () => {
    process.env.OPENCHROME_BUILD_VERSION = '9.8.7';
    process.env.OPENCHROME_BUILD_COMMIT = 'a'.repeat(40);
    process.env.OPENCHROME_BUILD_TARGET = 'linux-x64';
    process.env.OPENCHROME_BUILD_BUNDLER = 'node-20';

    expect(getBuildInfo()).toEqual({
      version: '9.8.7',
      sourceCommit: 'a'.repeat(40),
      target: 'linux-x64',
      bundler: 'node-20',
    });
  });

  test('keeps npm execution backward compatible', () => {
    delete process.env.OPENCHROME_BUILD_VERSION;
    const info = getBuildInfo();
    expect(info.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(info.bundler).toContain('node-');
  });
});
