import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

test('fresh checkout and empty insertion tables cannot close G3', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-g3-'));
  const script = path.resolve('scripts/decisions/g3-closure-preflight.ts');
  const register = require.resolve('ts-node/register');
  try {
    const run = () => JSON.parse(execFileSync(process.execPath, ['-r', register, script], { cwd: dir, encoding: 'utf8', env: { ...process.env, TS_NODE_PROJECT: path.resolve('tsconfig.json') } }));
    expect(run().ok_to_close).toBe(false);
    const out = path.join(dir, 'artifacts/decision/G3');
    fs.writeFileSync(path.join(out, 'insertion-tables.json'), JSON.stringify({ tables: [] }));
    expect(run().failed).toContain('decision_model_column');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}, 30000);
