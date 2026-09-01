import path from 'path';
import { resolveServeInvocation } from '../../cli/serve-invocation';

describe('serve invocation', () => {
  test('npm CLI spawns the compiled server entry through Node', () => {
    const invocation = resolveServeInvocation('dist/index.js', ['--server-mode']);
    expect(invocation).toEqual({
      command: process.execPath,
      args: [path.resolve('dist/index.js'), 'serve', '--server-mode'],
    });
  });
});
