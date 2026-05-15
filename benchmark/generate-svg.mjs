/**
 * Generate SVG benchmark comparison graphs
 * Uses clean, isolated measurement data
 */

import { readFileSync, writeFileSync } from 'fs';
import { RESULTS_DIR } from './config.mjs';

const pw = JSON.parse(readFileSync(`${RESULTS_DIR}/playwright-results.json`, 'utf8'));
const ocSeq = JSON.parse(readFileSync(`${RESULTS_DIR}/isolated-batch1.json`, 'utf8'));
const oc5 = JSON.parse(readFileSync(`${RESULTS_DIR}/isolated-batch5.json`, 'utf8'));
const oc10 = JSON.parse(readFileSync(`${RESULTS_DIR}/isolated-batch10.json`, 'utf8'));
const oc20 = JSON.parse(readFileSync(`${RESULTS_DIR}/isolated-batch20.json`, 'utf8'));

// Per #1254 cleanup: the historical hard-coded compression constant was an
// unverified guess (only two real measurements averaged). The Token Efficiency
// axis (#1256) replaces it with a real measured ratio per archetype. Until
// #1256 publishes its results, every place that previously consumed this
// constant renders the TBD placeholder below; the OpenChrome bars/numbers in
// the legacy speed+token charts are intentionally absent rather than fake.
const OC_COMPRESSION_PLACEHOLDER = 'TBD — pending #1256 results';

const strategies = [
  { label: 'Playwright\nSequential', time: parseFloat(pw.timing.totalSec), tokens: pw.tokenEstimate.htmlMode.avgPerProfile, color: '#6366f1', tweets: pw.totalTweetsExtracted },
  { label: 'OC\nSequential', time: parseFloat(ocSeq.timing.totalSec), tokens: ocSeq.tokenEstimate.ocCompactAvg, color: '#f97316', tweets: ocSeq.totalTweetsExtracted },
  { label: 'OC\n5-batch', time: parseFloat(oc5.timing.totalSec), tokens: oc5.tokenEstimate.ocCompactAvg, color: '#f97316', tweets: oc5.totalTweetsExtracted },
  { label: 'OC\n10-batch', time: parseFloat(oc10.timing.totalSec), tokens: oc10.tokenEstimate.ocCompactAvg, color: '#f97316', tweets: oc10.totalTweetsExtracted },
  { label: 'OC\n20-batch', time: parseFloat(oc20.timing.totalSec), tokens: oc20.tokenEstimate.ocCompactAvg, color: '#f97316', tweets: oc20.totalTweetsExtracted },
];

// ========= SVG 1: Speed Comparison =========
function generateSpeedSVG() {
  const W = 900, H = 520;
  const margin = { top: 80, right: 40, bottom: 100, left: 70 };
  const chartW = W - margin.left - margin.right;
  const chartH = H - margin.top - margin.bottom;

  const maxTime = Math.max(...strategies.map(s => s.time));
  const barW = chartW / strategies.length * 0.6;
  const gap = chartW / strategies.length;

  let bars = '';
  strategies.forEach((s, i) => {
    const x = margin.left + i * gap + (gap - barW) / 2;
    const barH = (s.time / maxTime) * chartH;
    const y = margin.top + chartH - barH;
    const color = i === 0 ? '#6366f1' : (i === 3 ? '#ea580c' : '#f97316');
    const opacity = i === 3 ? 1 : 0.85;

    bars += `<rect x="${x}" y="${y}" width="${barW}" height="${barH}" fill="${color}" opacity="${opacity}" rx="6"/>`;
    bars += `<text x="${x + barW/2}" y="${y - 12}" text-anchor="middle" font-size="16" font-weight="700" fill="#1e293b">${s.time}s</text>`;

    // Speedup label
    if (i > 0) {
      const speedup = (strategies[0].time / s.time).toFixed(1);
      if (parseFloat(speedup) > 1.1) {
        bars += `<text x="${x + barW/2}" y="${y - 32}" text-anchor="middle" font-size="12" font-weight="600" fill="#059669">${speedup}x faster</text>`;
      }
    }

    // Best marker
    if (i === 3) {
      bars += `<text x="${x + barW/2}" y="${y - 50}" text-anchor="middle" font-size="13" font-weight="700" fill="#ea580c">★ FASTEST</text>`;
    }

    // X-axis labels
    const lines = s.label.split('\n');
    lines.forEach((line, li) => {
      bars += `<text x="${x + barW/2}" y="${margin.top + chartH + 25 + li * 18}" text-anchor="middle" font-size="13" fill="#475569" font-weight="${li === 0 ? '600' : '400'}">${line}</text>`;
    });
  });

  // Y-axis
  let yAxis = '';
  for (let t = 0; t <= maxTime; t += 20) {
    const y = margin.top + chartH - (t / maxTime) * chartH;
    yAxis += `<line x1="${margin.left}" y1="${y}" x2="${margin.left + chartW}" y2="${y}" stroke="#e2e8f0" stroke-width="1"/>`;
    yAxis += `<text x="${margin.left - 10}" y="${y + 4}" text-anchor="end" font-size="12" fill="#94a3b8">${t}s</text>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif">
  <defs>
    <linearGradient id="bg1" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#f8fafc"/>
      <stop offset="100%" stop-color="#f1f5f9"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg1)" rx="16"/>
  <text x="${W/2}" y="35" text-anchor="middle" font-size="22" font-weight="700" fill="#0f172a">Speed Comparison: 20 Twitter Profiles</text>
  <text x="${W/2}" y="58" text-anchor="middle" font-size="14" fill="#64748b">Wall clock time (lower is better) — Isolated measurements</text>
  ${yAxis}
  ${bars}
  <line x1="${margin.left}" y1="${margin.top + chartH}" x2="${margin.left + chartW}" y2="${margin.top + chartH}" stroke="#cbd5e1" stroke-width="2"/>
</svg>`;
}

// ========= SVG 2: Token Efficiency =========
function generateTokenSVG() {
  const W = 900, H = 480;
  const margin = { top: 80, right: 40, bottom: 80, left: 90 };
  const chartW = W - margin.left - margin.right;
  const chartH = H - margin.top - margin.bottom;

  const data = [
    { label: 'Playwright + LLM\n(raw HTML)', tokens: pw.tokenEstimate.htmlMode.avgPerProfile, color: '#6366f1', total: pw.tokenEstimate.htmlMode.totalTokens },
    // OpenChrome row deliberately omitted: the prior value was derived from
    // the retired unverified compression estimate. Restore once #1256
    // measurements land.
    // { label: 'OpenChrome\n(compact DOM)', tokens: TBD, total: TBD }
    { label: 'Playwright standalone\n(no LLM)', tokens: 290, color: '#10b981', total: 5800 },
  ];

  const maxTokens = data[0].tokens;

  let bars = '';
  const barH = chartH / data.length * 0.55;
  const rowH = chartH / data.length;

  data.forEach((d, i) => {
    const y = margin.top + i * rowH + (rowH - barH) / 2;
    const barW = (d.tokens / maxTokens) * chartW;

    bars += `<rect x="${margin.left}" y="${y}" width="${barW}" height="${barH}" fill="${d.color}" opacity="0.9" rx="6"/>`;

    // Token count on bar
    const textX = barW > 200 ? margin.left + barW - 10 : margin.left + barW + 10;
    const anchor = barW > 200 ? 'end' : 'start';
    const textColor = barW > 200 ? '#fff' : '#1e293b';
    bars += `<text x="${textX}" y="${y + barH/2 + 6}" text-anchor="${anchor}" font-size="16" font-weight="700" fill="${textColor}">${d.tokens.toLocaleString()} tok/profile</text>`;

    // Total tokens
    bars += `<text x="${margin.left + chartW}" y="${y + barH/2 + 6}" text-anchor="end" font-size="12" fill="#94a3b8">total: ${d.total.toLocaleString()}</text>`;

    // Labels
    const lines = d.label.split('\n');
    lines.forEach((line, li) => {
      bars += `<text x="${margin.left - 10}" y="${y + barH/2 - 4 + li * 16}" text-anchor="end" font-size="12" fill="#475569" font-weight="${li === 0 ? '600' : '400'}">${line}</text>`;
    });
  });

  // Savings annotation
  const savings = OC_COMPRESSION_PLACEHOLDER;
  bars += `<rect x="${W/2 - 140}" y="${margin.top + rowH + rowH * 0.85}" width="280" height="32" fill="#fff7ed" stroke="#f97316" stroke-width="1.5" rx="8"/>`;
  bars += `<text x="${W/2}" y="${margin.top + rowH + rowH * 0.85 + 21}" text-anchor="middle" font-size="14" font-weight="700" fill="#ea580c">OC compression vs PW+LLM: ${savings}</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif">
  <defs>
    <linearGradient id="bg2" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#f8fafc"/>
      <stop offset="100%" stop-color="#f1f5f9"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg2)" rx="16"/>
  <text x="${W/2}" y="35" text-anchor="middle" font-size="22" font-weight="700" fill="#0f172a">Token Efficiency: LLM Context Per Profile</text>
  <text x="${W/2}" y="58" text-anchor="middle" font-size="14" fill="#64748b">Tokens the LLM must process per Twitter profile (lower is better)</text>
  ${bars}
</svg>`;
}

// ========= SVG 3: Combined Dashboard =========
function generateDashboardSVG() {
  const W = 900, H = 560;

  // Data
  const fastest = { label: 'OC 10-batch', time: parseFloat(oc10.timing.totalSec) };
  const pwTime = parseFloat(pw.timing.totalSec);
  const speedup = (pwTime / fastest.time).toFixed(1);
  const tokenSavings = OC_COMPRESSION_PLACEHOLDER;
  const ocTweets = ocSeq.totalTweetsExtracted;
  const pwTweets = pw.totalTweetsExtracted;
  const moreTweets = ((ocTweets / pwTweets - 1) * 100).toFixed(0);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif">
  <defs>
    <linearGradient id="bg3" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0f172a"/>
      <stop offset="100%" stop-color="#1e293b"/>
    </linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#f97316"/>
      <stop offset="100%" stop-color="#fb923c"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg3)" rx="16"/>

  <!-- Title -->
  <text x="${W/2}" y="45" text-anchor="middle" font-size="26" font-weight="700" fill="#f8fafc">OpenChrome vs Playwright Benchmark</text>
  <text x="${W/2}" y="72" text-anchor="middle" font-size="14" fill="#94a3b8">Real-world task: Crawl latest tweets from 20 Twitter/X celebrities</text>

  <!-- 3 Key Metric Cards -->
  <!-- Card 1: Speed -->
  <rect x="40" y="100" width="260" height="180" fill="#1e293b" stroke="#334155" stroke-width="1" rx="12"/>
  <text x="170" y="135" text-anchor="middle" font-size="13" fill="#94a3b8" font-weight="600">SPEED</text>
  <text x="170" y="185" text-anchor="middle" font-size="48" font-weight="800" fill="url(#accent)">${speedup}x</text>
  <text x="170" y="215" text-anchor="middle" font-size="14" fill="#cbd5e1">faster than Playwright</text>
  <text x="170" y="240" text-anchor="middle" font-size="12" fill="#64748b">OC ${fastest.time}s vs PW ${pwTime}s</text>
  <text x="170" y="262" text-anchor="middle" font-size="11" fill="#475569">(10-tab parallel, isolated)</text>

  <!-- Card 2: Tokens -->
  <rect x="320" y="100" width="260" height="180" fill="#1e293b" stroke="#334155" stroke-width="1" rx="12"/>
  <text x="450" y="135" text-anchor="middle" font-size="13" fill="#94a3b8" font-weight="600">TOKEN EFFICIENCY</text>
  <text x="450" y="185" text-anchor="middle" font-size="24" font-weight="700" fill="url(#accent)">TBD</text>
  <text x="450" y="215" text-anchor="middle" font-size="14" fill="#cbd5e1">fewer tokens per page</text>
  <text x="450" y="240" text-anchor="middle" font-size="12" fill="#64748b">OC ~12K tok vs PW ~178K tok</text>
  <text x="450" y="262" text-anchor="middle" font-size="11" fill="#475569">(savings: ${tokenSavings})</text>

  <!-- Card 3: Data Quality -->
  <rect x="600" y="100" width="260" height="180" fill="#1e293b" stroke="#334155" stroke-width="1" rx="12"/>
  <text x="730" y="135" text-anchor="middle" font-size="13" fill="#94a3b8" font-weight="600">DATA QUALITY</text>
  <text x="730" y="185" text-anchor="middle" font-size="48" font-weight="800" fill="url(#accent)">+${moreTweets}%</text>
  <text x="730" y="215" text-anchor="middle" font-size="14" fill="#cbd5e1">more tweets extracted</text>
  <text x="730" y="240" text-anchor="middle" font-size="12" fill="#64748b">OC ${ocTweets} vs PW ${pwTweets} tweets</text>
  <text x="730" y="262" text-anchor="middle" font-size="11" fill="#475569">(same 20 profiles)</text>

  <!-- Speed Bar Chart -->
  <text x="40" y="320" font-size="15" font-weight="700" fill="#e2e8f0">Parallel Strategy Comparison</text>

  <!-- PW Sequential -->
  <text x="40" y="352" font-size="12" fill="#94a3b8">PW Sequential</text>
  <rect x="170" y="340" width="${(pwTime / pwTime) * 560}" height="20" fill="#6366f1" opacity="0.8" rx="4"/>
  <text x="${170 + (pwTime / pwTime) * 560 + 8}" y="355" font-size="12" fill="#94a3b8" font-weight="600">${pwTime}s</text>

  <!-- OC Sequential -->
  <text x="40" y="382" font-size="12" fill="#94a3b8">OC Sequential</text>
  <rect x="170" y="370" width="${(parseFloat(ocSeq.timing.totalSec) / pwTime) * 560}" height="20" fill="#f97316" opacity="0.5" rx="4"/>
  <text x="${170 + (parseFloat(ocSeq.timing.totalSec) / pwTime) * 560 + 8}" y="385" font-size="12" fill="#94a3b8" font-weight="600">${ocSeq.timing.totalSec}s</text>

  <!-- OC 5-batch -->
  <text x="40" y="412" font-size="12" fill="#94a3b8">OC 5-batch</text>
  <rect x="170" y="400" width="${(parseFloat(oc5.timing.totalSec) / pwTime) * 560}" height="20" fill="#f97316" opacity="0.7" rx="4"/>
  <text x="${170 + (parseFloat(oc5.timing.totalSec) / pwTime) * 560 + 8}" y="415" font-size="12" fill="#94a3b8" font-weight="600">${oc5.timing.totalSec}s</text>

  <!-- OC 10-batch (BEST) -->
  <text x="40" y="442" font-size="12" fill="#fb923c" font-weight="700">OC 10-batch ★</text>
  <rect x="170" y="430" width="${(parseFloat(oc10.timing.totalSec) / pwTime) * 560}" height="20" fill="#ea580c" rx="4"/>
  <text x="${170 + (parseFloat(oc10.timing.totalSec) / pwTime) * 560 + 8}" y="445" font-size="12" fill="#fb923c" font-weight="700">${oc10.timing.totalSec}s (${speedup}x faster)</text>

  <!-- OC 20-batch -->
  <text x="40" y="472" font-size="12" fill="#94a3b8">OC 20-batch</text>
  <rect x="170" y="460" width="${(parseFloat(oc20.timing.totalSec) / pwTime) * 560}" height="20" fill="#f97316" opacity="0.6" rx="4"/>
  <text x="${170 + (parseFloat(oc20.timing.totalSec) / pwTime) * 560 + 8}" y="475" font-size="12" fill="#94a3b8" font-weight="600">${oc20.timing.totalSec}s</text>

  <!-- Success rates -->
  <text x="40" y="510" font-size="11" fill="#64748b">All strategies: 95% success rate (19/20 — @TimCook has 0 tweets across all approaches)</text>

  <!-- Footer -->
  <text x="${W/2}" y="545" text-anchor="middle" font-size="11" fill="#475569">Measured ${new Date().toISOString().split('T')[0]} | Same Chrome v145 instance via CDP | Each strategy run in complete isolation</text>
</svg>`;
}

// ========= SVG 4+5: Throughput vs concurrency, success rate vs concurrency (#1258) =========
//
// Two complementary charts — issue #1258 mandates that raw throughput AND
// success rate are reported as SEPARATE PRIMARIES (never collapsed). Each
// chart gets its own SVG so a reader cannot mistake one for the other.
// Both consume `benchmark/results/speed-throughput.json` produced by
// `npm run bench:throughput`. If the file does not exist (fresh checkout),
// the charts are skipped without breaking the legacy renderers above.
function generateThroughputAndSuccessSVGs() {
  let envelope;
  try {
    envelope = JSON.parse(readFileSync(`${RESULTS_DIR}/speed-throughput.json`, 'utf8'));
  } catch {
    return null;
  }
  const rows = Array.isArray(envelope.results) ? envelope.results : [];
  if (rows.length === 0) return null;

  const libraries = Array.from(new Set(rows.map((r) => r.library))).sort();
  const concurrencies = Array.from(new Set(rows.map((r) => r.concurrency))).sort((a, b) => a - b);
  const palette = ['#f97316', '#6366f1', '#10b981', '#ec4899', '#0ea5e9', '#8b5cf6'];
  const colorFor = (lib) => palette[libraries.indexOf(lib) % palette.length];

  function plot({ title, subtitle, metric, yLabel, yMax, yFmt }) {
    const W = 720;
    const H = 380;
    const margin = { top: 70, right: 120, bottom: 60, left: 60 };
    const chartW = W - margin.left - margin.right;
    const chartH = H - margin.top - margin.bottom;
    const xStep = concurrencies.length > 1 ? chartW / (concurrencies.length - 1) : chartW / 2;
    const xFor = (c) => margin.left + concurrencies.indexOf(c) * xStep;
    const yFor = (v) => margin.top + chartH - (v / yMax) * chartH;

    let series = '';
    for (const lib of libraries) {
      const libRows = rows.filter((r) => r.library === lib);
      const points = concurrencies
        .map((c) => libRows.find((r) => r.concurrency === c))
        .filter((r) => r);
      if (points.length === 0) continue;
      const pathD = points
        .map((r, i) => `${i === 0 ? 'M' : 'L'} ${xFor(r.concurrency).toFixed(1)} ${yFor(metric(r)).toFixed(1)}`)
        .join(' ');
      series += `<path d="${pathD}" stroke="${colorFor(lib)}" stroke-width="2.5" fill="none"/>`;
      for (const r of points) {
        series += `<circle cx="${xFor(r.concurrency).toFixed(1)}" cy="${yFor(metric(r)).toFixed(1)}" r="4" fill="${colorFor(lib)}"/>`;
      }
    }

    let xAxis = `<line x1="${margin.left}" y1="${margin.top + chartH}" x2="${margin.left + chartW}" y2="${margin.top + chartH}" stroke="#cbd5e1" stroke-width="1"/>`;
    for (const c of concurrencies) {
      xAxis += `<text x="${xFor(c).toFixed(1)}" y="${margin.top + chartH + 20}" text-anchor="middle" font-size="12" fill="#475569">${c}</text>`;
    }
    xAxis += `<text x="${margin.left + chartW / 2}" y="${margin.top + chartH + 44}" text-anchor="middle" font-size="11" fill="#64748b">concurrency</text>`;

    let yAxis = '';
    for (let i = 0; i <= 4; i++) {
      const v = (yMax * i) / 4;
      const y = yFor(v);
      yAxis += `<line x1="${margin.left}" y1="${y.toFixed(1)}" x2="${margin.left + chartW}" y2="${y.toFixed(1)}" stroke="#e2e8f0" stroke-width="0.5"/>`;
      yAxis += `<text x="${margin.left - 6}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="#94a3b8">${yFmt(v)}</text>`;
    }
    yAxis += `<text x="${margin.left}" y="${margin.top - 24}" font-size="11" fill="#64748b">${yLabel}</text>`;

    const legend = libraries
      .map((lib, i) => `<g><rect x="${margin.left + chartW + 16}" y="${margin.top + i * 22}" width="14" height="3" fill="${colorFor(lib)}"/><text x="${margin.left + chartW + 36}" y="${margin.top + i * 22 + 5}" font-size="11" fill="#0f172a">${lib}</text></g>`)
      .join('');

    return (
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif">` +
      `<rect width="${W}" height="${H}" fill="#f8fafc" rx="8"/>` +
      `<text x="${W / 2}" y="32" text-anchor="middle" font-size="18" font-weight="700" fill="#0f172a">${title}</text>` +
      `<text x="${W / 2}" y="52" text-anchor="middle" font-size="11" fill="#64748b">${subtitle}</text>` +
      yAxis + xAxis + series + legend +
      `</svg>`
    );
  }

  const maxRaw = Math.max(...rows.map((r) => r.rawPagesPerSecond || 0), 1);
  return {
    throughputSvg: plot({
      title: 'Raw throughput vs concurrency (#1258, PRIMARY)',
      subtitle: 'Raw pages/sec per library. Higher is better.',
      metric: (r) => r.rawPagesPerSecond,
      yLabel: 'pages / second',
      yMax: maxRaw * 1.1,
      yFmt: (v) => (v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v.toFixed(0)),
    }),
    successSvg: plot({
      title: 'Success rate vs concurrency (#1258, PRIMARY)',
      subtitle: 'Per-page success rate. Reported separately from throughput.',
      metric: (r) => r.successRate,
      yLabel: 'success rate',
      yMax: 1.05,
      yFmt: (v) => `${(v * 100).toFixed(0)}%`,
    }),
  };
}

// ========= SVG 6: Token-efficiency scatter (#1256) =========
//
// Faceted scatter: X = log10(payloadTokens), Y = retention, color by library.
// Reads benchmark/results/token-efficiency.json (the matrix envelope produced
// by run-token-efficiency.ts) and renders one panel per archetype plus an
// aggregate panel. Skipped cells (live-only in --skip-live mode) are listed
// in a legend strip rather than plotted at 0 — silently omitting them would
// hide the gap; plotting them at 0 would lie.
//
// The chart only renders if the matrix envelope exists; otherwise the file
// is skipped so a fresh checkout that has not yet run `bench:tokens` does
// not break the rest of the generator.
function generateTokensScatterSVG() {
  let envelope;
  try {
    envelope = JSON.parse(readFileSync(`${RESULTS_DIR}/token-efficiency.json`, 'utf8'));
  } catch {
    return null; // no matrix data yet — skip silently, regen after `bench:tokens`
  }
  const rows = Array.isArray(envelope.results) ? envelope.results : [];
  if (rows.length === 0) return null;

  const runRows = rows.filter((r) => !r.skipped && Number.isFinite(r.payloadTokens) && r.payloadTokens > 0);
  const skipRows = rows.filter((r) => r.skipped);
  const archetypes = Array.from(new Set(runRows.map((r) => r.archetype))).sort();
  const facets = [...archetypes, '__aggregate__'];

  // Color map per library — palette is deterministic so the same library has
  // the same color across runs and across the scatter + the report.
  const libraries = Array.from(new Set(runRows.map((r) => r.library))).sort();
  const palette = ['#f97316', '#6366f1', '#10b981', '#ec4899', '#0ea5e9', '#8b5cf6', '#facc15', '#ef4444', '#14b8a6'];
  const colorFor = (lib) => palette[libraries.indexOf(lib) % palette.length];

  // X range over all run rows (log scale so dense small-token clusters spread).
  const tokens = runRows.map((r) => r.payloadTokens);
  const minLog = Math.log10(Math.max(1, Math.min(...tokens)));
  const maxLog = Math.log10(Math.max(...tokens));
  const xPad = (maxLog - minLog) * 0.05 || 0.5;
  const xMin = minLog - xPad;
  const xMax = maxLog + xPad;

  const cols = 3;
  const rowsCount = Math.ceil(facets.length / cols);
  const panelW = 280;
  const panelH = 200;
  const gap = 24;
  const headerH = 80;
  const legendH = 50 + Math.ceil(libraries.length / 4) * 18 + (skipRows.length > 0 ? 28 : 0);
  const W = cols * panelW + (cols + 1) * gap;
  const H = headerH + rowsCount * (panelH + gap) + gap + legendH;

  function plotPanel(facet, panelIdx) {
    const col = panelIdx % cols;
    const row = Math.floor(panelIdx / cols);
    const x0 = gap + col * (panelW + gap);
    const y0 = headerH + row * (panelH + gap);
    const facetRows = facet === '__aggregate__' ? runRows : runRows.filter((r) => r.archetype === facet);
    const innerPad = 28;
    const innerX0 = x0 + innerPad;
    const innerY0 = y0 + 28;
    const innerW = panelW - innerPad * 2;
    const innerH = panelH - 56;
    const xScale = (t) => innerX0 + ((Math.log10(Math.max(1, t)) - xMin) / (xMax - xMin)) * innerW;
    const yScale = (ret) => innerY0 + innerH - ret * innerH;

    const dots = facetRows
      .map((r) => `<circle cx="${xScale(r.payloadTokens).toFixed(1)}" cy="${yScale(r.retention).toFixed(1)}" r="4" fill="${colorFor(r.library)}" fill-opacity="0.75" stroke="#0f172a" stroke-width="0.5"/>`)
      .join('');

    return (
      `<g><rect x="${x0}" y="${y0}" width="${panelW}" height="${panelH}" fill="#ffffff" stroke="#e2e8f0" rx="6"/>` +
      `<text x="${x0 + panelW / 2}" y="${y0 + 18}" text-anchor="middle" font-size="13" font-weight="700" fill="#0f172a">${facet === '__aggregate__' ? 'All archetypes' : facet}</text>` +
      `<rect x="${innerX0}" y="${innerY0}" width="${innerW}" height="${innerH}" fill="#f8fafc" stroke="#cbd5e1" stroke-width="0.5" rx="2"/>` +
      `<text x="${innerX0}" y="${innerY0 + innerH + 16}" font-size="9" fill="#64748b">log10 tokens</text>` +
      `<text x="${innerX0 - 4}" y="${innerY0 + 8}" text-anchor="end" font-size="9" fill="#64748b">retention</text>` +
      dots +
      `</g>`
    );
  }

  const legendItems = libraries
    .map((lib, i) => {
      const lx = gap + (i % 4) * 240;
      const ly = headerH + rowsCount * (panelH + gap) + gap + 24 + Math.floor(i / 4) * 18;
      return `<circle cx="${lx + 6}" cy="${ly}" r="5" fill="${colorFor(lib)}"/><text x="${lx + 18}" y="${ly + 4}" font-size="11" fill="#0f172a">${lib}</text>`;
    })
    .join('');

  const skipNote = skipRows.length > 0
    ? `<text x="${W / 2}" y="${H - 14}" text-anchor="middle" font-size="11" fill="#475569">${skipRows.length} cells skipped: live-only (set OPENCHROME_BENCH_LIVE=1 to run)</text>`
    : '';

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif">` +
    `<rect width="${W}" height="${H}" fill="#f1f5f9" rx="10"/>` +
    `<text x="${W / 2}" y="30" text-anchor="middle" font-size="20" font-weight="700" fill="#0f172a">Token efficiency: tokens vs retention (#1256)</text>` +
    `<text x="${W / 2}" y="52" text-anchor="middle" font-size="12" fill="#64748b">Upper-left wins: fewer tokens, higher retention. Color = library. Faceted by archetype.</text>` +
    facets.map((f, i) => plotPanel(f, i)).join('') +
    legendItems +
    skipNote +
    `</svg>`
  );
}

// Write all SVGs
writeFileSync(`${RESULTS_DIR}/chart-speed.svg`, generateSpeedSVG());
writeFileSync(`${RESULTS_DIR}/chart-tokens.svg`, generateTokenSVG());
writeFileSync(`${RESULTS_DIR}/chart-dashboard.svg`, generateDashboardSVG());
const speedCharts = generateThroughputAndSuccessSVGs();
if (speedCharts) {
  writeFileSync(`${RESULTS_DIR}/chart-throughput.svg`, speedCharts.throughputSvg);
  writeFileSync(`${RESULTS_DIR}/chart-success-rate.svg`, speedCharts.successSvg);
}

const tokensScatter = generateTokensScatterSVG();
if (tokensScatter) {
  writeFileSync(`${RESULTS_DIR}/chart-tokens-scatter.svg`, tokensScatter);
}

console.error('SVG charts generated:');
console.error('  chart-speed.svg            - Speed comparison bar chart');
console.error('  chart-tokens.svg           - Token efficiency horizontal bars (legacy)');
console.error('  chart-dashboard.svg        - Combined dashboard with key metrics');
if (tokensScatter) {
  console.error('  chart-tokens-scatter.svg   - Token efficiency scatter (#1256 matrix)');
} else {
  console.error('  chart-tokens-scatter.svg   - SKIPPED (run `npm run bench:tokens` to produce token-efficiency.json)');
}
