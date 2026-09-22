import * as fs from 'fs';
import * as path from 'path';

const source = path.join('docs', 'dev', 'HANDOFF.md');
const outDir = path.join('artifacts', 'decision', 'G3');
fs.mkdirSync(outDir, { recursive: true });
const output = path.join(outDir, 'HANDOFF.md');
fs.copyFileSync(source, output);
console.log(JSON.stringify({ source, output, verification: 'documentation_only' }, null, 2));
