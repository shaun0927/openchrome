import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const DIST_WRAPPER = path.join(process.cwd(), 'dist', 'cli', 'index.js');
const DIST_SERVER = path.join(process.cwd(), 'dist', 'index.js');

function runWrapper(args: string[]) {
  return spawnSync(process.execPath, [DIST_WRAPPER, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, OPENCHROME_UPDATE_CHECK: '0' },
  });
}

function runServer(args: string[]) {
  return spawnSync(process.execPath, [DIST_SERVER, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, OPENCHROME_UPDATE_CHECK: '0' },
  });
}

describe('CLI entrypoint parity', () => {
  test('npm scripts use the full CLI for runtime status commands', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
    expect(pkg.scripts.start).toBe('node dist/index.js serve');
    expect(pkg.scripts.check).toBe('node dist/index.js check');
  });

  test.each([
    [['doctor', '--help'], ['--json', '--remote']],
    [['help', 'doctor'], ['--json', '--remote']],
    [['check', '--help'], ['--port']],
    [['help', 'check'], ['--port']],
    [['serve', '--help'], ['--broker', '--connect-broker', '--auto-elect']],
    [['help', 'serve'], ['--broker', '--connect-broker', '--auto-elect']],
  ])('bin wrapper forwards %j to the full CLI help surface', (args, expectedFlags) => {
    const result = runWrapper(args);
    expect(result.status).toBe(0);
    for (const flag of expectedFlags) {
      expect(result.stdout).toContain(flag);
    }
  });


  test.each([
    [['help', 'launch'], 'Usage: openchrome launch'],
    [['help', 'sessions'], 'Usage: openchrome sessions'],
  ])('bin wrapper preserves local help for %j', (args, expectedUsage) => {
    const result = runWrapper(args);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(expectedUsage);
  });

  test('bin wrapper does not own stdin EOF or SIGHUP lifecycle', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'cli', 'index.ts'), 'utf8');
    expect(source).not.toContain("process.stdin.on('end'");
    expect(source).not.toContain("process.on('SIGHUP'");
    expect(source).toContain("child.on('exit', (code, signal)");
    expect(source).toContain('SIGNAL_EXIT_CODES');
  });

  test('full and minimal introspection expose different deterministic surfaces', () => {
    const full = runServer(['serve', '--introspect-tools-list']);
    const minimal = runServer(['serve', '--minimal', '--introspect-tools-list']);
    expect(full.status).toBe(0);
    expect(minimal.status).toBe(0);
    const fullTools = JSON.parse(full.stdout) as Array<{ name: string }>;
    const minimalTools = JSON.parse(minimal.stdout) as Array<{ name: string }>;
    expect(fullTools.length).toBeGreaterThan(minimalTools.length);
    expect(fullTools.some((tool) => tool.name === 'expand_tools')).toBe(false);
    expect(minimalTools.some((tool) => tool.name === 'expand_tools')).toBe(true);
  });
});
