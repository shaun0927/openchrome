import { getClaudeCliCommand, getClaudeExecFileOptions } from '../../cli/claude-cli';

describe('cli/claude-cli', () => {
  test('uses the npm .cmd shim on Windows', () => {
    expect(getClaudeCliCommand('win32')).toBe('claude.cmd');
  });

  test('uses the bare executable on non-Windows platforms', () => {
    expect(getClaudeCliCommand('darwin')).toBe('claude');
    expect(getClaudeCliCommand('linux')).toBe('claude');
  });

  test('execFile options enable shell execution for Windows .cmd shims', () => {
    expect(getClaudeExecFileOptions('pipe', 'win32')).toEqual({
      stdio: 'pipe',
      shell: true,
    });
  });

  test('execFile options preserve shell-free execution on non-Windows platforms', () => {
    expect(getClaudeExecFileOptions('inherit', 'darwin')).toEqual({
      stdio: 'inherit',
    });
  });
});
