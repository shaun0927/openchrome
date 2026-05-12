import * as fs from 'fs';
import * as path from 'path';
import { extractMainContent, toMarkdown } from '../../../src/core/extract/html-to-markdown';

const FIXTURES = path.join(__dirname, 'fixtures');

describe('extractMainContent', () => {
  it('removes script/style/noscript/iframe/svg', () => {
    const html = `
      <html><body>
        <script>alert(1)</script>
        <style>body{color:red}</style>
        <noscript>noscript</noscript>
        <svg><circle/></svg>
        <iframe src="x"></iframe>
        <p>hello</p>
      </body></html>`;
    const { html: out, stripped } = extractMainContent(html, { onlyMainContent: false });
    expect(out).toContain('hello');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('<style');
    expect(out).not.toContain('<noscript');
    expect(out).not.toContain('<svg');
    expect(out).not.toContain('<iframe');
    expect(stripped).toEqual(expect.arrayContaining(['script', 'style', 'noscript', 'svg', 'iframe']));
  });

  it('removes nav/header/footer/aside when onlyMainContent is true', () => {
    const html = `
      <html><body>
        <header>HEADER</header>
        <nav>NAV</nav>
        <aside>ASIDE</aside>
        <main><p>BODY</p></main>
        <footer>FOOTER</footer>
      </body></html>`;
    const { html: out } = extractMainContent(html, { onlyMainContent: true });
    expect(out).toContain('BODY');
    expect(out).not.toContain('HEADER');
    expect(out).not.toContain('NAV');
    expect(out).not.toContain('ASIDE');
    expect(out).not.toContain('FOOTER');
  });

  it('keeps nav/header/footer when onlyMainContent is false', () => {
    const html = `<body><nav>NAV</nav><p>BODY</p><footer>FOOT</footer></body>`;
    const { html: out } = extractMainContent(html, { onlyMainContent: false });
    expect(out).toContain('NAV');
    expect(out).toContain('FOOT');
  });

  it('narrows scope to <main> when present', () => {
    const html = `<body><div>OUTSIDE</div><main><p>INSIDE</p></main></body>`;
    const { html: out } = extractMainContent(html, { onlyMainContent: true });
    expect(out).toContain('INSIDE');
    expect(out).not.toContain('OUTSIDE');
  });

  it('narrows scope to <article> when no <main>', () => {
    const html = `<body><div>OUTSIDE</div><article><p>INSIDE</p></article></body>`;
    const { html: out } = extractMainContent(html, { onlyMainContent: true });
    expect(out).toContain('INSIDE');
    expect(out).not.toContain('OUTSIDE');
  });

  it('narrows scope to [role="main"] as fallback', () => {
    const html = `<body><div>OUTSIDE</div><section role="main"><p>INSIDE</p></section></body>`;
    const { html: out } = extractMainContent(html, { onlyMainContent: true });
    expect(out).toContain('INSIDE');
    expect(out).not.toContain('OUTSIDE');
  });

  it('removes cookie banners and ads', () => {
    const html = `
      <body>
        <div class="cookie-banner">cookies</div>
        <div class="advert-top">ad</div>
        <div class="popup-modal">popup</div>
        <p>real content</p>
      </body>`;
    const { html: out } = extractMainContent(html, { onlyMainContent: true });
    expect(out).toContain('real content');
    expect(out).not.toContain('cookies');
    expect(out).not.toContain('>ad<');
    expect(out).not.toContain('popup');
  });

  it('removes aria-hidden elements', () => {
    const html = `<body><span aria-hidden="true">HIDDEN</span><p>VISIBLE</p></body>`;
    const { html: out } = extractMainContent(html, { onlyMainContent: false });
    expect(out).not.toContain('HIDDEN');
    expect(out).toContain('VISIBLE');
  });
});

describe('toMarkdown', () => {
  it('converts headings with atx style', () => {
    expect(toMarkdown('<h1>A</h1><h2>B</h2><h3>C</h3>')).toContain('# A');
    expect(toMarkdown('<h2>B</h2>')).toContain('## B');
  });

  it('preserves links by default', () => {
    const md = toMarkdown('<p>See <a href="https://example.com">site</a></p>');
    expect(md).toContain('[site](https://example.com)');
  });

  it('strips links when includeLinks is false', () => {
    const md = toMarkdown('<p>See <a href="https://example.com">site</a></p>', { includeLinks: false });
    expect(md).not.toContain('](https://example.com)');
    expect(md).toContain('site');
  });

  it('preserves fenced code blocks', () => {
    const md = toMarkdown('<pre><code>const x = 1;</code></pre>');
    expect(md).toContain('```');
    expect(md).toContain('const x = 1;');
  });

  it('preserves tables as GFM', () => {
    const html = `
      <table>
        <thead><tr><th>A</th><th>B</th></tr></thead>
        <tbody>
          <tr><td>1</td><td>2</td></tr>
          <tr><td>3</td><td>4</td></tr>
        </tbody>
      </table>`;
    const md = toMarkdown(html);
    expect(md).toContain('| A | B |');
    expect(md).toContain('| --- | --- |');
    expect(md).toContain('| 1 | 2 |');
    expect(md).toContain('| 3 | 4 |');
  });

  it('handles tables without thead', () => {
    const html = '<table><tr><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></table>';
    const md = toMarkdown(html);
    expect(md).toContain('| 1 | 2 |');
    expect(md).toContain('| 3 | 4 |');
  });

  it('escapes pipe characters in table cells', () => {
    const md = toMarkdown('<table><tr><th>x|y</th></tr><tr><td>a|b</td></tr></table>');
    expect(md).toContain('x\\|y');
    expect(md).toContain('a\\|b');
  });

  it('returns empty for empty table', () => {
    const md = toMarkdown('<table></table>');
    expect(md).toBe('');
  });

  it('preserves bullet lists with - marker', () => {
    const md = toMarkdown('<ul><li>one</li><li>two</li></ul>');
    expect(md).toMatch(/-\s+one/);
    expect(md).toMatch(/-\s+two/);
  });
});

describe('html-to-markdown integration on fixture', () => {
  it('produces the committed expected.clean.md byte-identical', () => {
    const html = fs.readFileSync(path.join(FIXTURES, 'wikipedia.html'), 'utf8');
    const expected = fs.readFileSync(path.join(FIXTURES, 'wikipedia.expected.clean.md'), 'utf8');
    const { html: cleaned } = extractMainContent(html, { onlyMainContent: true });
    const md = toMarkdown(cleaned, { includeLinks: true });
    expect(md).toBe(expected);
  });

  it('clean output contains no script/style and no nav text', () => {
    const html = fs.readFileSync(path.join(FIXTURES, 'wikipedia.html'), 'utf8');
    const { html: cleaned } = extractMainContent(html, { onlyMainContent: true });
    const md = toMarkdown(cleaned, { includeLinks: true });
    expect(md).not.toContain('<script');
    expect(md).not.toContain('<style');
    expect(md).not.toContain('Jump to navigation');
    expect(md).not.toContain('Main page');
    expect(md).toMatch(/\[[^\]]+\]\(https?:\/\/[^)]+\)/);
  });

  it('opt-out (onlyMainContent=false) keeps nav text', () => {
    const html = fs.readFileSync(path.join(FIXTURES, 'wikipedia.html'), 'utf8');
    const { html: cleaned } = extractMainContent(html, { onlyMainContent: false });
    const md = toMarkdown(cleaned, { includeLinks: true });
    expect(md).toContain('Main page');
  });
});
