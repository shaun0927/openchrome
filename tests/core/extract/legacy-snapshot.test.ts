import * as fs from 'fs';
import * as path from 'path';
import { legacyExtractMarkdown } from '../../helpers/legacy-markdown-walker';

const FIXTURES = path.join(__dirname, 'fixtures');
const normalizeFixtureText = (text: string) => text.replace(/\r\n/g, '\n');

describe('legacy markdown walker P2 zero-impact snapshot', () => {
  it('produces byte-identical output to wikipedia.expected.legacy.md', () => {
    const html = fs.readFileSync(path.join(FIXTURES, 'wikipedia.html'), 'utf8');
    const expected = normalizeFixtureText(fs.readFileSync(path.join(FIXTURES, 'wikipedia.expected.legacy.md'), 'utf8'));
    const md = legacyExtractMarkdown(html);
    expect(md).toBe(expected);
  });
});
