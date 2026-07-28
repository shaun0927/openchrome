import path from 'path';
import { resolveServeInvocation } from '../../cli/serve-invocation';

describe('standalone serve invocation', () => {
  const original = process.env.OPENCHROME_STANDALONE_BINARY;

  afterEach(() => {
    if (original === undefined) delete process.env.OPENCHROME_STANDALONE_BINARY;
    else process.env.OPENCHROME_STANDALONE_BINARY = original;
  });

  test('npm CLI spawns the compiled server entry through Node', () => {
    delete process.env.OPENCHROME_STANDALONE_BINARY;
    const invocation = resolveServeInvocation('dist/index.js', ['--server-mode']);
    expect(invocation).toEqual({
      command: process.execPath,
      args: [path.resolve('dist/index.js'), 'serve', '--server-mode'],
    });
  });

  test('standalone CLI self-spawns without a script path', () => {
    process.env.OPENCHROME_STANDALONE_BINARY = '1';
    const invocation = resolveServeInvocation('/missing/dist/index.js', ['--minimal']);
    expect(invocation).toEqual({
      command: process.execPath,
      args: ['serve', '--minimal'],
    });
  });
});
