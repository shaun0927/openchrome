import * as fs from 'node:fs';
import * as path from 'node:path';
import { METHOD_SUPPORT } from '../../src/mcp/protocol-matrix';

const DOC = path.join(__dirname, '..', '..', 'docs', 'mcp-2026-07-28.md');

describe('MCP protocol support matrix', () => {
  test('docs/mcp-2026-07-28.md carries exactly the implemented matrix', () => {
    const text = fs.readFileSync(DOC, 'utf8');
    const block = /<!-- protocol-matrix:begin -->\s*```json\s*([\s\S]*?)```\s*<!-- protocol-matrix:end -->/.exec(text);
    expect(block).not.toBeNull();
    expect(JSON.parse(block![1])).toEqual(JSON.parse(JSON.stringify(METHOD_SUPPORT)));
  });
});
