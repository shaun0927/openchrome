import { getBuildInfo } from '../../cli/build-info';

describe('CLI build provenance', () => {
  const original = { ...process.env };

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in original)) delete process.env[key];
    }
    Object.assign(process.env, original);
  });

  test('uses embedded standalone metadata when present', () => {
    process.env.OPENCHROME_STANDALONE_BINARY = '1';
    process.env.OPENCHROME_BUILD_VERSION = '9.8.7';
    process.env.OPENCHROME_BUILD_COMMIT = 'a'.repeat(40);
    process.env.OPENCHROME_BUILD_TARGET = 'x86_64-unknown-linux-gnu';
    process.env.OPENCHROME_BUILD_BUNDLER = 'bun-1.3.14';

    expect(getBuildInfo()).toEqual({
      version: '9.8.7',
      sourceCommit: 'a'.repeat(40),
      target: 'x86_64-unknown-linux-gnu',
      bundler: 'bun-1.3.14',
      standalone: true,
    });
  });

  test('keeps npm execution backward compatible', () => {
    delete process.env.OPENCHROME_STANDALONE_BINARY;
    delete process.env.OPENCHROME_BUILD_VERSION;
    const info = getBuildInfo();
    expect(info.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(info.standalone).toBe(false);
    expect(info.bundler).toContain('node-');
  });
});
