import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createLayaLocalProvider } from '../../scripts/decisions/providers/laya-local';
import type { DecisionCase } from '../fixtures/decisions/schema';

const example: DecisionCase = { id: 'test', kind: 'irreversible', lang: 'en', pool: 'fixture', input: { tool: 'click', args: {}, page_context: {} } };
let dir: string;
const originalEnabled = process.env.LAYA_LOCAL_ENABLED;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-laya-test-'));
  process.env.LAYA_LOCAL_ENABLED = '1';
});
afterEach(async () => {
  if (originalEnabled === undefined) delete process.env.LAYA_LOCAL_ENABLED;
  else process.env.LAYA_LOCAL_ENABLED = originalEnabled;
  await fs.rm(dir, { recursive: true, force: true });
});

test('disabled provider does not spawn an executable', async () => {
  delete process.env.LAYA_LOCAL_ENABLED;
  expect(await createLayaLocalProvider({ layaPython: 'missing-executable' }).init?.()).toMatchObject({ skipped: expect.any(String) });
});

test('missing executable rejects instead of crashing the parent', async () => {
  const provider = createLayaLocalProvider({ layaPython: path.join(dir, 'missing'), layaTimeoutMs: 500 });
  try { await expect(provider.init?.()).rejects.toThrow('could not start'); }
  finally { await provider.close?.(); }
});

test.each(['malformed', 'hang', 'valid'])('worker protocol handles %s response', async (mode) => {
  const worker = path.join(dir, 'worker.cjs');
  await fs.writeFile(worker, `process.stdout.write(JSON.stringify({type:'ready'})+'\\n');
    process.stdin.on('data', data => {
      const req = JSON.parse(String(data));
      if (${JSON.stringify(mode)} === 'hang') return;
      process.stdout.write(${JSON.stringify(mode)} === 'malformed' ? 'bad-json\\n' : JSON.stringify({id:req.id,ok:true,body:{q:'allow'}})+'\\n');
    }); process.stdin.on('end',()=>process.exit(0));`);
  const provider = createLayaLocalProvider({ layaPython: process.execPath, layaWorkerPath: worker, layaTimeoutMs: 1000 });
  try {
    await provider.init?.();
    if (mode === 'valid') await expect(provider.decide(example)).resolves.toMatchObject({ answer: 'allow' });
    else await expect(provider.decide(example)).rejects.toThrow(mode === 'hang' ? 'timed out' : 'invalid JSON');
  } finally { await provider.close?.(); }
});
