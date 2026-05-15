#!/usr/bin/env node
/**
 * Generate the token-efficiency fixture corpus for the Token Efficiency axis (#1256).
 *
 * Produces 5 archetypes × 10 instances = 50 fixture pairs under
 *   tests/benchmark/fixtures/token-efficiency/{archetype}/{archetype}-NN.html
 *   tests/benchmark/fixtures/token-efficiency/{archetype}/{archetype}-NN.ground-truth.json
 *
 * Every fixture ships a ground-truth.json with >= 12 fields (MIN_GROUND_TRUTH_FIELDS
 * in tests/benchmark/token-efficiency.ts), spanning the four RUBRIC.md categories
 * (structured data, primary content, navigation/interactive, metadata).
 *
 * The fixtures are *templated synthetic HTML* — author-owned by this repository,
 * so they are license-safe by construction. The template intentionally pads each
 * fixture with representative chrome (nav, sidebar, footer, repeated related-
 * content blocks, SPA hydration shims) so the compression ratio reflects a real
 * "12 fields out of a full page" workflow and not a stripped-down benchmark
 * cherry-pick.
 *
 * Run:
 *
 *   node scripts/bench/generate-token-fixtures.mjs
 *
 * The generator is deterministic: a given input set produces byte-identical
 * output, so the committed fixture files in git reflect this script verbatim
 * and a CI run can regenerate them if needed. Tests load the committed files;
 * the generator is the authoring tool, not a runtime path.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURES_DIR = path.join(
  REPO_ROOT,
  'tests',
  'benchmark',
  'fixtures',
  'token-efficiency',
);

const INSTANCES_PER_ARCHETYPE = 10;

function pad(n) {
  return String(n).padStart(2, '0');
}

function noiseBlock(label, i) {
  return (
    `<div class="noise-row" data-row="${i}">` +
    `<span class="label">${label} ${i}</span>` +
    `<p>Supplementary content block ${i} — navigation chrome, tracking ` +
    `markup, and layout wrappers that an LLM does not need.</p>` +
    `<a href="/related/${label.toLowerCase()}-${i}">more ${i}</a></div>`
  );
}

function noiseSection(label, count) {
  const rows = [];
  for (let i = 0; i < count; i++) rows.push(noiseBlock(label, i));
  return `<section class="noise">${rows.join('')}</section>`;
}

function fixtureHtml({ title, lang = 'en', body, noiseCount }) {
  return (
    '<!doctype html><html lang="' + lang + '"><head>' +
    `<meta charset="utf-8"><title>${title}</title>` +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="generator" content="openchrome-token-efficiency-fixture">' +
    '<link rel="stylesheet" href="/static/site.css">' +
    '</head><body>' +
    '<header class="site-header"><nav class="site-nav">' +
    '<a href="/">Home</a><a href="/about">About</a>' +
    '<a href="/contact">Contact</a></nav></header>' +
    body +
    noiseSection('Related', noiseCount) +
    '<aside class="sidebar">' +
    '<ul><li>Sidebar 1</li><li>Sidebar 2</li><li>Sidebar 3</li></ul></aside>' +
    '<footer><p>fixture footer — openchrome benchmark</p></footer>' +
    '</body></html>'
  );
}

function field(key, value) {
  return `<span data-field="${key}">${value}</span>`;
}

// ------------------------------------------------------------------
// Archetype templates
// ------------------------------------------------------------------

const ECOMMERCE_VARIANTS = [
  { product: 'Wireless Headphones', brand: 'Acme Audio', sku: 'AA-WH-001', priceNum: 199.0, color: 'Midnight Black', category: 'Audio' },
  { product: 'Bluetooth Speaker', brand: 'Acme Audio', sku: 'AA-BS-014', priceNum: 89.5, color: 'Slate Gray', category: 'Audio' },
  { product: 'Mechanical Keyboard', brand: 'Keycraft', sku: 'KC-MK-077', priceNum: 149.0, color: 'Arctic White', category: 'Peripherals' },
  { product: 'Wireless Mouse', brand: 'Keycraft', sku: 'KC-WM-022', priceNum: 39.0, color: 'Charcoal', category: 'Peripherals' },
  { product: 'Standing Desk', brand: 'Workspace Co', sku: 'WC-SD-110', priceNum: 599.0, color: 'Walnut', category: 'Furniture' },
  { product: 'Ergonomic Chair', brand: 'Workspace Co', sku: 'WC-EC-203', priceNum: 449.0, color: 'Graphite', category: 'Furniture' },
  { product: 'USB-C Hub', brand: 'PortCorp', sku: 'PC-UC-005', priceNum: 59.0, color: 'Space Gray', category: 'Accessories' },
  { product: 'External SSD', brand: 'PortCorp', sku: 'PC-SS-018', priceNum: 129.0, color: 'Slate', category: 'Storage' },
  { product: 'Laptop Stand', brand: 'Workspace Co', sku: 'WC-LS-301', priceNum: 79.0, color: 'Aluminum', category: 'Accessories' },
  { product: 'Webcam 4K', brand: 'OpticLab', sku: 'OL-WC-049', priceNum: 119.0, color: 'Matte Black', category: 'Peripherals' },
];

function ecommerceFixture(i) {
  const v = ECOMMERCE_VARIANTS[i];
  const price = `$${v.priceNum.toFixed(2)}`;
  const rating = (4.2 + (i % 8) * 0.1).toFixed(1);
  const reviewCount = String(800 + i * 137);
  const fields = [
    { key: 'title', expected: v.product },
    { key: 'price', expected: price },
    { key: 'brand', expected: v.brand },
    { key: 'sku', expected: v.sku },
    { key: 'rating', expected: rating },
    { key: 'reviewCount', expected: reviewCount },
    { key: 'availability', expected: 'In stock' },
    { key: 'primaryCta', expected: 'Add to cart' },
    { key: 'shippingNote', expected: 'Free shipping over $50' },
    { key: 'category', expected: v.category },
    { key: 'color', expected: v.color },
    { key: 'warranty', expected: '2 year limited' },
  ];
  const body =
    `<main class="product-page">` +
    `<nav class="breadcrumb">Home / ${field('category', v.category)} / ${v.product}</nav>` +
    `<article class="product">` +
    `<h1>${field('title', v.product)}</h1>` +
    `<p class="brand">by ${field('brand', v.brand)}</p>` +
    `<p class="sku">SKU: ${field('sku', v.sku)}</p>` +
    `<div class="pricing"><strong>${field('price', price)}</strong></div>` +
    `<div class="rating">${field('rating', rating)} stars (${field('reviewCount', reviewCount)} reviews)</div>` +
    `<p class="availability">${field('availability', 'In stock')}</p>` +
    `<button class="cta">${field('primaryCta', 'Add to cart')}</button>` +
    `<p class="shipping">${field('shippingNote', 'Free shipping over $50')}</p>` +
    `<p class="color">Color: ${field('color', v.color)}</p>` +
    `<p class="warranty">Warranty: ${field('warranty', '2 year limited')}</p>` +
    `<section class="description"><p>The ${v.product} from ${v.brand} delivers reliable performance for everyday use, designed and tested for long sessions.</p></section>` +
    `</article></main>`;
  return { fields, body, noiseCount: 120, title: v.product };
}

const NEWS_VARIANTS = [
  { headline: 'City Council Approves Transit Expansion', author: 'Jordan Reyes', section: 'Local', topic: 'Transportation', slug: 'transit-expansion' },
  { headline: 'Researchers Identify New Coastal Species', author: 'Priya Sharma', section: 'Science', topic: 'Biology', slug: 'coastal-species' },
  { headline: 'Power Grid Upgrades Roll Out This Summer', author: 'Marcus Bell', section: 'Local', topic: 'Infrastructure', slug: 'grid-upgrade' },
  { headline: 'School District Adopts New Curriculum', author: 'Hannah Park', section: 'Education', topic: 'Policy', slug: 'curriculum-change' },
  { headline: 'Air Quality Index Improves Year Over Year', author: 'Diego Alvarez', section: 'Environment', topic: 'Air Quality', slug: 'air-quality' },
  { headline: 'Library Board Funds Open Source Program', author: 'Ana Costa', section: 'Local', topic: 'Technology', slug: 'oss-program' },
  { headline: 'Hospital Network Expands Mental Health Care', author: 'Sam Tanaka', section: 'Health', topic: 'Wellness', slug: 'mental-health-care' },
  { headline: 'Bike Lane Network Adds Twelve Miles', author: 'Luca Romano', section: 'Local', topic: 'Transportation', slug: 'bike-lane' },
  { headline: 'University Launches Open Data Portal', author: 'Riley Chen', section: 'Education', topic: 'Open Data', slug: 'open-data-portal' },
  { headline: 'Public Park Reopens After Restoration', author: 'Noor Patel', section: 'Local', topic: 'Parks', slug: 'park-reopens' },
];

function newsFixture(i) {
  const v = NEWS_VARIANTS[i];
  const day = pad(((i * 3) % 28) + 1);
  const month = pad(((i * 2) % 12) + 1);
  const date = `2026-${month}-${day}`;
  const wordCount = String(620 + i * 78);
  const readTime = String(3 + Math.floor(i / 3));
  const canonical = `https://news.example/${v.slug}`;
  const summary = `${v.headline} — overview piece covering the rollout and stakeholder reactions.`;
  const fields = [
    { key: 'headline', expected: v.headline },
    { key: 'author', expected: v.author },
    { key: 'publishedDate', expected: date },
    { key: 'section', expected: v.section },
    { key: 'summary', expected: summary },
    { key: 'wordCount', expected: wordCount },
    { key: 'primaryCta', expected: 'Subscribe' },
    { key: 'canonicalUrl', expected: canonical },
    { key: 'category', expected: v.topic },
    { key: 'readingTime', expected: `${readTime} min` },
    { key: 'language', expected: 'en' },
    { key: 'breadcrumb', expected: `Home / ${v.section} / ${v.topic}` },
  ];
  const body =
    `<main class="article-page">` +
    `<nav class="breadcrumb">${field('breadcrumb', `Home / ${v.section} / ${v.topic}`)}</nav>` +
    `<article class="article">` +
    `<h1>${field('headline', v.headline)}</h1>` +
    `<p class="byline">By ${field('author', v.author)} · ${field('publishedDate', date)} · ${field('section', v.section)} · ${field('readingTime', `${readTime} min`)}</p>` +
    `<p class="summary">${field('summary', summary)}</p>` +
    `<p class="meta">Words: ${field('wordCount', wordCount)} | Lang: ${field('language', 'en')} | Category: ${field('category', v.topic)}</p>` +
    `<button class="cta">${field('primaryCta', 'Subscribe')}</button>` +
    `<link rel="canonical" href="${canonical}">` +
    `<p>Canonical: ${field('canonicalUrl', canonical)}</p>` +
    `<section class="body-copy"><p>The full article continues with additional context, named sources, statistics and direct quotes. ${v.headline} marks a notable shift in regional policy and will be revisited in follow-up coverage.</p></section>` +
    `</article></main>`;
  return { fields, body, noiseCount: 160, title: v.headline };
}

const DOCS_VARIANTS = [
  { topic: 'Configuring the HTTP Transport', section: 'Transports', version: 'v2', slug: 'http-transport', codeLang: 'bash', prev: 'Transport Overview', next: 'Configuring SSE' },
  { topic: 'Configuring SSE', section: 'Transports', version: 'v2', slug: 'sse-transport', codeLang: 'bash', prev: 'HTTP Transport', next: 'WebSocket Transport' },
  { topic: 'Hooks Reference', section: 'Extending', version: 'v2', slug: 'hooks-reference', codeLang: 'json', prev: 'Plugins Overview', next: 'Custom Tools' },
  { topic: 'Authentication Setup', section: 'Security', version: 'v2', slug: 'auth-setup', codeLang: 'bash', prev: 'Permissions', next: 'Rate Limiting' },
  { topic: 'Permissions Model', section: 'Security', version: 'v2', slug: 'permissions', codeLang: 'json', prev: 'Auth Setup', next: 'Audit Logging' },
  { topic: 'Profiles and Sessions', section: 'Concepts', version: 'v2', slug: 'profiles-sessions', codeLang: 'bash', prev: 'Workspaces', next: 'Tabs' },
  { topic: 'Logging and Telemetry', section: 'Operations', version: 'v2', slug: 'logging-telemetry', codeLang: 'yaml', prev: 'Health Checks', next: 'Metrics Export' },
  { topic: 'Metrics Export', section: 'Operations', version: 'v2', slug: 'metrics-export', codeLang: 'yaml', prev: 'Logging', next: 'Alerting' },
  { topic: 'Custom Tools', section: 'Extending', version: 'v2', slug: 'custom-tools', codeLang: 'typescript', prev: 'Hooks Reference', next: 'Tool Schemas' },
  { topic: 'CLI Reference', section: 'Reference', version: 'v2', slug: 'cli-reference', codeLang: 'bash', prev: 'Configuration', next: 'Environment Variables' },
];

function docsFixture(i) {
  const v = DOCS_VARIANTS[i];
  const day = pad(((i * 2) % 28) + 1);
  const month = pad(((i + 3) % 12) + 1);
  const lastUpdated = `2026-${month}-${day}`;
  const canonical = `https://docs.example/${v.slug}`;
  const summary = `Guide to ${v.topic.toLowerCase()} for openchrome ${v.version}.`;
  const fields = [
    { key: 'title', expected: v.topic },
    { key: 'apiVersion', expected: v.version },
    { key: 'category', expected: v.section },
    { key: 'summary', expected: summary },
    { key: 'lastUpdated', expected: lastUpdated },
    { key: 'primaryCta', expected: 'Copy snippet' },
    { key: 'canonicalUrl', expected: canonical },
    { key: 'breadcrumb', expected: `Docs / ${v.section} / ${v.topic}` },
    { key: 'codeLanguage', expected: v.codeLang },
    { key: 'language', expected: 'en' },
    { key: 'nextPage', expected: v.next },
    { key: 'prevPage', expected: v.prev },
  ];
  const body =
    `<main class="docs-page">` +
    `<nav class="breadcrumb">${field('breadcrumb', `Docs / ${v.section} / ${v.topic}`)}</nav>` +
    `<article class="docs">` +
    `<h1>${field('title', v.topic)}</h1>` +
    `<p class="version">API ${field('apiVersion', v.version)} · ${field('category', v.section)} · last updated ${field('lastUpdated', lastUpdated)}</p>` +
    `<p class="summary">${field('summary', summary)}</p>` +
    `<pre><code class="language-${v.codeLang}">$ example ${v.slug}</code></pre>` +
    `<p class="code-lang">Code: ${field('codeLanguage', v.codeLang)} · Lang: ${field('language', 'en')}</p>` +
    `<button class="cta">${field('primaryCta', 'Copy snippet')}</button>` +
    `<p>Canonical: ${field('canonicalUrl', canonical)}</p>` +
    `<nav class="pager">← ${field('prevPage', v.prev)} | ${field('nextPage', v.next)} →</nav>` +
    `</article></main>`;
  return { fields, body, noiseCount: 90, title: v.topic };
}

const SPA_VARIANTS = [
  { app: 'WaveFeed', user: '@alex', post: 'Shipping the new compaction pipeline this week', avatar: 'Alex avatar', action: 'Compose', search: 'Search posts' },
  { app: 'WaveFeed', user: '@priya', post: 'Demo recording of the new layout engine', avatar: 'Priya avatar', action: 'Compose', search: 'Search posts' },
  { app: 'TaskHub', user: '@jordan', post: 'Sprint 5 retrospective notes are up', avatar: 'Jordan avatar', action: 'New task', search: 'Search tasks' },
  { app: 'TaskHub', user: '@marcus', post: 'Closing the last three review threads', avatar: 'Marcus avatar', action: 'New task', search: 'Search tasks' },
  { app: 'MapPad', user: '@hannah', post: 'Annotated city park boundaries for the weekend run', avatar: 'Hannah avatar', action: 'Create map', search: 'Search maps' },
  { app: 'MapPad', user: '@diego', post: 'Beach cleanup pin set published', avatar: 'Diego avatar', action: 'Create map', search: 'Search maps' },
  { app: 'PodCircle', user: '@ana', post: 'Episode 42 transcript drafted and ready', avatar: 'Ana avatar', action: 'Record', search: 'Search shows' },
  { app: 'PodCircle', user: '@sam', post: 'New show art uploaded for the season opener', avatar: 'Sam avatar', action: 'Record', search: 'Search shows' },
  { app: 'CodeNotes', user: '@luca', post: 'Pinned the migration checklist for the team', avatar: 'Luca avatar', action: 'New note', search: 'Search notes' },
  { app: 'CodeNotes', user: '@riley', post: 'Closed the lingering follow-up about the cache eviction policy', avatar: 'Riley avatar', action: 'New note', search: 'Search notes' },
];

function spaFixture(i) {
  const v = SPA_VARIANTS[i];
  const likes = String(40 + i * 17);
  const replies = String(3 + (i % 9));
  const shares = String(2 + (i % 6));
  const hh = pad((9 + (i % 10)) % 24);
  const mm = pad((11 + i * 7) % 60);
  const timestamp = `2026-05-${pad(((i * 2) % 28) + 1)} ${hh}:${mm} UTC`;
  const postBody = `${v.post}. Posted via the ${v.app} mobile client.`;
  const fields = [
    { key: 'appName', expected: v.app },
    { key: 'userHandle', expected: v.user },
    { key: 'primaryAction', expected: v.action },
    { key: 'postTitle', expected: v.post },
    { key: 'postBody', expected: postBody },
    { key: 'likeCount', expected: likes },
    { key: 'replyCount', expected: replies },
    { key: 'shareCount', expected: shares },
    { key: 'timestamp', expected: timestamp },
    { key: 'authorAvatarAlt', expected: v.avatar },
    { key: 'navigationPrimary', expected: 'Feed' },
    { key: 'searchPlaceholder', expected: v.search },
  ];
  const hydration = Array.from({ length: 40 }, (_, k) =>
    `<script type="application/json" data-react-hydration="${k}">{"id":"h-${k}","state":"idle","ts":${1700000000 + k}}</script>`,
  ).join('');
  const body =
    `<main class="app" data-app="${v.app}">` +
    `<header class="app-header">` +
    `<span class="brand">${field('appName', v.app)}</span>` +
    `<input class="search" placeholder="${v.search}">` +
    `<span data-field="searchPlaceholder">${v.search}</span>` +
    `<button class="primary-action">${field('primaryAction', v.action)}</button>` +
    `</header>` +
    `<nav class="primary-nav"><a class="active">${field('navigationPrimary', 'Feed')}</a><a>Notifications</a><a>Profile</a></nav>` +
    `<article class="post">` +
    `<img alt="${v.avatar}"><span data-field="authorAvatarAlt">${v.avatar}</span>` +
    `<p class="handle">${field('userHandle', v.user)} · ${field('timestamp', timestamp)}</p>` +
    `<h2>${field('postTitle', v.post)}</h2>` +
    `<p class="body">${field('postBody', postBody)}</p>` +
    `<div class="counters">❤ ${field('likeCount', likes)} · 💬 ${field('replyCount', replies)} · 🔁 ${field('shareCount', shares)}</div>` +
    `</article>` +
    hydration +
    `</main>`;
  return { fields, body, noiseCount: 140, title: `${v.app} — ${v.post.slice(0, 40)}` };
}

const SEARCH_VARIANTS = [
  { q: 'open source browser automation', total: '12,400', topic: 'browser-automation' },
  { q: 'mcp server tutorial', total: '4,820', topic: 'mcp' },
  { q: 'chrome devtools protocol guide', total: '9,150', topic: 'cdp' },
  { q: 'web scraping best practices', total: '23,600', topic: 'scraping' },
  { q: 'headless chrome alternatives', total: '6,030', topic: 'headless' },
  { q: 'playwright vs puppeteer', total: '18,200', topic: 'playwright' },
  { q: 'ai agent web tools', total: '7,440', topic: 'ai-agents' },
  { q: 'extraction format comparison', total: '3,180', topic: 'extraction' },
  { q: 'token efficiency benchmark', total: '1,910', topic: 'token-efficiency' },
  { q: 'crawl rate limiting strategies', total: '5,260', topic: 'rate-limit' },
];

function searchResultsFixture(i) {
  const v = SEARCH_VARIANTS[i];
  const r1 = {
    title: `Authoritative guide to ${v.topic}`,
    url: `https://example.com/${v.topic}/guide`,
    snippet: `An overview of ${v.q} with worked examples, configuration knobs, and reference benchmarks.`,
  };
  const r2 = {
    title: `${v.topic} community write-up`,
    url: `https://blog.example.com/${v.topic}/community`,
    snippet: `Community discussion thread on ${v.q} covering edge cases and pitfalls.`,
  };
  const r3 = {
    title: `${v.topic} reference documentation`,
    url: `https://docs.example.com/${v.topic}`,
    snippet: `Reference docs for ${v.q} — types, options, error codes.`,
  };
  const fields = [
    { key: 'query', expected: v.q },
    { key: 'totalResults', expected: v.total },
    { key: 'result1Title', expected: r1.title },
    { key: 'result1Url', expected: r1.url },
    { key: 'result1Snippet', expected: r1.snippet },
    { key: 'result2Title', expected: r2.title },
    { key: 'result2Url', expected: r2.url },
    { key: 'result2Snippet', expected: r2.snippet },
    { key: 'result3Title', expected: r3.title },
    { key: 'result3Url', expected: r3.url },
    { key: 'paginationNext', expected: 'Next page' },
    { key: 'filterPrimary', expected: 'Past year' },
  ];
  const result = (n, r) =>
    `<li class="result">` +
    `<h3><a href="${r.url}">${field(`result${n}Title`, r.title)}</a></h3>` +
    `<p class="url">${field(`result${n}Url`, r.url)}</p>` +
    (r.snippet ? `<p class="snippet">${field(`result${n}Snippet`, r.snippet)}</p>` : '') +
    `</li>`;
  const body =
    `<main class="search-page">` +
    `<form class="search-form"><input value="${v.q}"><span data-field="query">${v.q}</span></form>` +
    `<p class="result-count">About ${field('totalResults', v.total)} results</p>` +
    `<aside class="filters"><button class="active">${field('filterPrimary', 'Past year')}</button><button>Past month</button><button>Past week</button></aside>` +
    `<ol class="results">${result(1, r1)}${result(2, r2)}${result(3, r3)}</ol>` +
    `<nav class="pagination"><a class="prev">Previous</a><a class="next">${field('paginationNext', 'Next page')}</a></nav>` +
    `</main>`;
  return { fields, body, noiseCount: 110, title: `Search: ${v.q}` };
}

const ARCHETYPES = {
  ecommerce: ecommerceFixture,
  news: newsFixture,
  docs: docsFixture,
  spa: spaFixture,
  'search-results': searchResultsFixture,
};

function writeFixture(archetype, index, spec) {
  const dir = path.join(FIXTURES_DIR, archetype);
  fs.mkdirSync(dir, { recursive: true });
  const name = `${archetype}-${pad(index + 1)}`;
  const html = fixtureHtml({
    title: spec.title,
    body: spec.body,
    noiseCount: spec.noiseCount,
  });
  const groundTruth = {
    fixture: name,
    fields: spec.fields.map(({ key, expected }) => ({ key, expected })),
  };
  fs.writeFileSync(path.join(dir, `${name}.html`), html);
  fs.writeFileSync(
    path.join(dir, `${name}.ground-truth.json`),
    JSON.stringify(groundTruth, null, 2) + '\n',
  );
  return { name, archetype, fieldCount: spec.fields.length, htmlBytes: Buffer.byteLength(html) };
}

function main() {
  fs.mkdirSync(FIXTURES_DIR, { recursive: true });
  const written = [];
  for (const [archetype, builder] of Object.entries(ARCHETYPES)) {
    for (let i = 0; i < INSTANCES_PER_ARCHETYPE; i++) {
      const spec = builder(i);
      const entry = writeFixture(archetype, i, spec);
      written.push(entry);
    }
  }
  for (const w of written) {
    process.stderr.write(`${w.name.padEnd(20)} ${String(w.fieldCount).padStart(2)} fields  ${String(w.htmlBytes).padStart(6)} bytes\n`);
  }
  process.stderr.write(`\nTotal: ${written.length} fixtures written to ${path.relative(REPO_ROOT, FIXTURES_DIR)}\n`);
}

main();
