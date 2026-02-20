/**
 * Complex E2E test: 20-site deep parallel crawling
 *
 * Each site gets FULL extraction:
 * - Meta tags + Open Graph
 * - Navigation structure
 * - All headings hierarchy
 * - Pricing/CTA detection
 * - Performance metrics (DOM size, load timing)
 * - Screenshot (base64, measured size)
 * - External links vs internal links
 * - Technology detection (frameworks, analytics)
 * - Accessibility audit (images without alt, form labels)
 *
 * Usage: npx ts-node tests/e2e/parallel-crawl-complex.ts
 */

import puppeteer, { Browser, Page } from 'puppeteer-core';

const SITES = [
  'https://www.github.com',
  'https://www.stackoverflow.com',
  'https://www.wikipedia.org',
  'https://www.apple.com',
  'https://www.microsoft.com',
  'https://www.npmjs.com',
  'https://www.cloudflare.com',
  'https://www.stripe.com',
  'https://www.vercel.com',
  'https://www.netlify.com',
  'https://www.docker.com',
  'https://www.mozilla.org',
  'https://www.rust-lang.org',
  'https://www.python.org',
  'https://www.typescriptlang.org',
  'https://www.figma.com',
  'https://www.notion.so',
  'https://www.linear.app',
  'https://www.tailwindcss.com',
  'https://nextjs.org',
];

interface SiteAnalysis {
  // Basic
  title: string;
  url: string;
  finalUrl: string;
  statusCode: number;

  // SEO / Meta
  meta: {
    description: string;
    ogTitle: string;
    ogImage: string;
    ogType: string;
    canonical: string;
    robots: string;
    twitterCard: string;
    favicon: string;
  };

  // Content structure
  headings: { tag: string; text: string }[];
  navLinks: { text: string; href: string }[];
  ctaButtons: { text: string; href: string }[];

  // Pricing detection
  pricing: { found: boolean; texts: string[] };

  // Links analysis
  links: {
    total: number;
    internal: number;
    external: number;
    topExternalDomains: string[];
  };

  // Tech detection
  tech: {
    frameworks: string[];
    analytics: string[];
    cdns: string[];
  };

  // Performance
  perf: {
    domNodes: number;
    domDepth: number;
    scriptCount: number;
    stylesheetCount: number;
    totalImageSize: number;
    loadTiming: number;
  };

  // Accessibility
  a11y: {
    imagesWithoutAlt: number;
    totalImages: number;
    formsWithoutLabels: number;
    ariaLandmarks: number;
    langAttribute: string;
  };

  // Screenshot
  screenshotSizeKB: number;
}

interface CrawlResult {
  site: string;
  status: 'success' | 'error';
  durationMs: number;
  phases: {
    navigate: number;
    metaExtract: number;
    contentExtract: number;
    techDetect: number;
    perfAudit: number;
    a11yAudit: number;
    screenshot: number;
  };
  data?: SiteAnalysis;
  error?: string;
}

async function deepCrawl(browser: Browser, url: string): Promise<CrawlResult> {
  const totalStart = Date.now();
  const phases = { navigate: 0, metaExtract: 0, contentExtract: 0, techDetect: 0, perfAudit: 0, a11yAudit: 0, screenshot: 0 };
  const context = await browser.createBrowserContext();

  try {
    const page = await context.newPage();
    await page.setViewport({ width: 1440, height: 900 });

    // Phase 1: Navigate
    let phaseStart = Date.now();
    let statusCode = 200;
    page.on('response', (res) => {
      if (res.url() === page.url() || res.url() === url) {
        statusCode = res.status();
      }
    });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
    phases.navigate = Date.now() - phaseStart;

    // Phase 2: Meta / SEO extraction
    phaseStart = Date.now();
    const meta = await page.evaluate(() => {
      const getMeta = (name: string) =>
        document.querySelector(`meta[name="${name}"], meta[property="${name}"]`)?.getAttribute('content') || '';
      const favicon = document.querySelector('link[rel="icon"], link[rel="shortcut icon"]')?.getAttribute('href') || '';
      return {
        description: getMeta('description'),
        ogTitle: getMeta('og:title'),
        ogImage: getMeta('og:image'),
        ogType: getMeta('og:type'),
        canonical: document.querySelector('link[rel="canonical"]')?.getAttribute('href') || '',
        robots: getMeta('robots'),
        twitterCard: getMeta('twitter:card'),
        favicon,
      };
    });
    phases.metaExtract = Date.now() - phaseStart;

    // Phase 3: Content structure extraction
    phaseStart = Date.now();
    const content = await page.evaluate(() => {
      // Headings hierarchy
      const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
        .slice(0, 15)
        .map(el => ({ tag: el.tagName.toLowerCase(), text: (el.textContent || '').trim().slice(0, 80) }))
        .filter(h => h.text.length > 0);

      // Navigation links
      const navLinks = Array.from(document.querySelectorAll('nav a, header a'))
        .slice(0, 20)
        .map(a => ({
          text: (a.textContent || '').trim().slice(0, 40),
          href: a.getAttribute('href') || '',
        }))
        .filter(l => l.text.length > 0);

      // CTA buttons
      const ctaButtons = Array.from(document.querySelectorAll(
        'a[class*="cta"], a[class*="btn"], a[class*="button"], button[class*="cta"], [class*="hero"] a, [class*="primary"] button'
      ))
        .slice(0, 10)
        .map(el => ({
          text: (el.textContent || '').trim().slice(0, 40),
          href: (el as HTMLAnchorElement).href || '',
        }))
        .filter(b => b.text.length > 0);

      // Pricing detection
      const bodyText = document.body?.innerText || '';
      const pricePatterns = bodyText.match(/\$\d+[\d,.]*(?:\s*\/\s*(?:mo|month|yr|year))?/gi) || [];
      const pricingWords = /pricing|price|plan|tier|free trial|enterprise|pro plan|starter/i.test(bodyText);

      // Links analysis
      const allLinks = Array.from(document.querySelectorAll('a[href]'));
      const currentHost = window.location.hostname;
      const externalLinks = allLinks.filter(a => {
        try {
          const linkHost = new URL((a as HTMLAnchorElement).href).hostname;
          return linkHost !== currentHost && linkHost !== '';
        } catch { return false; }
      });
      const externalDomains = [...new Set(externalLinks.map(a => {
        try { return new URL((a as HTMLAnchorElement).href).hostname; } catch { return ''; }
      }).filter(Boolean))].slice(0, 5);

      return {
        headings,
        navLinks,
        ctaButtons,
        pricing: {
          found: pricingWords || pricePatterns.length > 0,
          texts: pricePatterns.slice(0, 5),
        },
        links: {
          total: allLinks.length,
          internal: allLinks.length - externalLinks.length,
          external: externalLinks.length,
          topExternalDomains: externalDomains,
        },
      };
    });
    phases.contentExtract = Date.now() - phaseStart;

    // Phase 4: Technology detection
    phaseStart = Date.now();
    const tech = await page.evaluate(() => {
      const frameworks: string[] = [];
      const analytics: string[] = [];
      const cdns: string[] = [];
      const html = document.documentElement.outerHTML;
      const scripts = Array.from(document.querySelectorAll('script[src]')).map(s => s.getAttribute('src') || '');

      // Framework detection
      if ((window as any).__NEXT_DATA__) frameworks.push('Next.js');
      if ((window as any).__NUXT__) frameworks.push('Nuxt');
      if (document.querySelector('[data-reactroot], [data-reactid], #__next')) frameworks.push('React');
      if ((window as any).__VUE__) frameworks.push('Vue');
      if (document.querySelector('[ng-app], [ng-version]')) frameworks.push('Angular');
      if (html.includes('svelte')) frameworks.push('Svelte');
      if (scripts.some(s => s.includes('gatsby'))) frameworks.push('Gatsby');
      if (html.includes('tailwind') || html.includes('tw-')) frameworks.push('Tailwind CSS');

      // Analytics detection
      if (scripts.some(s => s.includes('google-analytics') || s.includes('gtag'))) analytics.push('Google Analytics');
      if (scripts.some(s => s.includes('segment'))) analytics.push('Segment');
      if (scripts.some(s => s.includes('hotjar'))) analytics.push('Hotjar');
      if (scripts.some(s => s.includes('mixpanel'))) analytics.push('Mixpanel');
      if (scripts.some(s => s.includes('amplitude'))) analytics.push('Amplitude');
      if (scripts.some(s => s.includes('intercom'))) analytics.push('Intercom');
      if (scripts.some(s => s.includes('sentry'))) analytics.push('Sentry');

      // CDN detection
      if (scripts.some(s => s.includes('cloudflare'))) cdns.push('Cloudflare');
      if (scripts.some(s => s.includes('cdn.jsdelivr'))) cdns.push('jsDelivr');
      if (scripts.some(s => s.includes('unpkg'))) cdns.push('unpkg');
      if (scripts.some(s => s.includes('cdnjs'))) cdns.push('cdnjs');
      if (scripts.some(s => s.includes('fastly'))) cdns.push('Fastly');

      return { frameworks, analytics, cdns };
    });
    phases.techDetect = Date.now() - phaseStart;

    // Phase 5: Performance audit
    phaseStart = Date.now();
    const perf = await page.evaluate(() => {
      // DOM complexity
      const allElements = document.querySelectorAll('*');
      const domNodes = allElements.length;
      let maxDepth = 0;
      const measureDepth = (el: Element, depth: number) => {
        if (depth > maxDepth) maxDepth = depth;
        if (depth < 30) { // Limit recursion
          for (const child of el.children) measureDepth(child, depth + 1);
        }
      };
      measureDepth(document.documentElement, 0);

      const scriptCount = document.querySelectorAll('script').length;
      const stylesheetCount = document.querySelectorAll('link[rel="stylesheet"]').length;

      // Image sizes
      const images = Array.from(document.querySelectorAll('img'));
      const totalImageSize = images.reduce((sum, img) => {
        return sum + (img.naturalWidth * img.naturalHeight * 4) / 1024; // rough KB estimate
      }, 0);

      // Load timing
      const timing = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
      const loadTiming = timing ? Math.round(timing.loadEventEnd - timing.startTime) : 0;

      return {
        domNodes,
        domDepth: maxDepth,
        scriptCount,
        stylesheetCount,
        totalImageSize: Math.round(totalImageSize),
        loadTiming,
      };
    });
    phases.perfAudit = Date.now() - phaseStart;

    // Phase 6: Accessibility audit
    phaseStart = Date.now();
    const a11y = await page.evaluate(() => {
      const images = document.querySelectorAll('img');
      const imagesWithoutAlt = Array.from(images).filter(img => !img.getAttribute('alt')).length;
      const inputs = document.querySelectorAll('input:not([type="hidden"]), textarea, select');
      const formsWithoutLabels = Array.from(inputs).filter(input => {
        const id = input.id;
        if (id && document.querySelector(`label[for="${id}"]`)) return false;
        if (input.getAttribute('aria-label') || input.getAttribute('aria-labelledby')) return false;
        if (input.closest('label')) return false;
        return true;
      }).length;
      const ariaLandmarks = document.querySelectorAll('[role="banner"], [role="navigation"], [role="main"], [role="contentinfo"], main, nav, header, footer').length;
      const langAttribute = document.documentElement.getAttribute('lang') || '';

      return {
        imagesWithoutAlt,
        totalImages: images.length,
        formsWithoutLabels,
        ariaLandmarks,
        langAttribute,
      };
    });
    phases.a11yAudit = Date.now() - phaseStart;

    // Phase 7: Screenshot
    phaseStart = Date.now();
    const screenshot = await page.screenshot({ encoding: 'base64', type: 'webp', quality: 60 });
    const screenshotSizeKB = Math.round(Buffer.from(screenshot, 'base64').length / 1024);
    phases.screenshot = Date.now() - phaseStart;

    const finalUrl = page.url();
    const title = await page.title();

    await context.close();
    const totalDuration = Date.now() - totalStart;

    return {
      site: url,
      status: 'success',
      durationMs: totalDuration,
      phases,
      data: {
        title, url, finalUrl, statusCode,
        meta, ...content, tech, perf, a11y, screenshotSizeKB,
      },
    };
  } catch (err) {
    await context.close().catch(() => {});
    return {
      site: url,
      status: 'error',
      durationMs: Date.now() - totalStart,
      phases,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function main() {
  console.log(`\n🚀 CCP Complex Parallel Crawl — ${SITES.length} sites × 7 extraction phases\n`);
  console.log('Connecting to Chrome on localhost:9222...');

  const browser = await puppeteer.connect({ browserURL: 'http://localhost:9222' });
  console.log('Connected. Launching deep parallel crawl...\n');

  // === PARALLEL ===
  const parallelStart = Date.now();
  const results = await Promise.all(SITES.map(url => deepCrawl(browser, url)));
  const parallelTotal = Date.now() - parallelStart;

  const successes = results.filter(r => r.status === 'success');
  const failures = results.filter(r => r.status === 'error');

  // === DETAILED RESULTS ===
  console.log('═'.repeat(95));

  for (const r of results) {
    const icon = r.status === 'success' ? '✓' : '✗';
    const host = new URL(r.site).hostname;

    if (r.data) {
      const d = r.data;
      console.log(`\n  ${icon} ${host}  (${r.durationMs}ms)`);
      console.log(`  ┌─ SEO ─────────────────────────────────────────────────────────────`);
      console.log(`  │ Title:       ${d.title.slice(0, 65)}`);
      if (d.meta.description) console.log(`  │ Description: ${d.meta.description.slice(0, 65)}...`);
      if (d.meta.ogImage) console.log(`  │ OG Image:    ${d.meta.ogImage.slice(0, 65)}`);
      console.log(`  │ Canonical:   ${d.meta.canonical.slice(0, 65) || '(none)'}`);

      console.log(`  ├─ Content ──────────────────────────────────────────────────────────`);
      console.log(`  │ Headings:    ${d.headings.length} (${d.headings.slice(0, 3).map(h => `${h.tag}:"${h.text.slice(0, 25)}"`).join(', ')})`);
      console.log(`  │ Nav links:   ${d.navLinks.length}`);
      console.log(`  │ CTA buttons: ${d.ctaButtons.length} (${d.ctaButtons.slice(0, 2).map(b => `"${b.text.slice(0, 20)}"`).join(', ') || 'none'})`);
      console.log(`  │ Pricing:     ${d.pricing.found ? `YES ${d.pricing.texts.slice(0, 3).join(', ')}` : 'No'}`);

      console.log(`  ├─ Links ───────────────────────────────────────────────────────────`);
      console.log(`  │ Total: ${d.links.total} | Internal: ${d.links.internal} | External: ${d.links.external}`);
      if (d.links.topExternalDomains.length) console.log(`  │ Top external: ${d.links.topExternalDomains.slice(0, 3).join(', ')}`);

      console.log(`  ├─ Tech ────────────────────────────────────────────────────────────`);
      console.log(`  │ Frameworks:  ${d.tech.frameworks.join(', ') || 'none detected'}`);
      console.log(`  │ Analytics:   ${d.tech.analytics.join(', ') || 'none detected'}`);

      console.log(`  ├─ Performance ──────────────────────────────────────────────────────`);
      console.log(`  │ DOM: ${d.perf.domNodes} nodes, depth ${d.perf.domDepth} | Scripts: ${d.perf.scriptCount} | Styles: ${d.perf.stylesheetCount}`);
      console.log(`  │ Load timing: ${d.perf.loadTiming}ms | Est. image data: ${d.perf.totalImageSize}KB`);

      console.log(`  ├─ Accessibility ────────────────────────────────────────────────────`);
      console.log(`  │ Lang: "${d.a11y.langAttribute}" | Landmarks: ${d.a11y.ariaLandmarks} | imgs w/o alt: ${d.a11y.imagesWithoutAlt}/${d.a11y.totalImages}`);

      console.log(`  └─ Screenshot: ${d.screenshotSizeKB}KB (webp)`);

      // Phase timing
      const p = r.phases;
      console.log(`     Phases: nav=${p.navigate}ms meta=${p.metaExtract}ms content=${p.contentExtract}ms tech=${p.techDetect}ms perf=${p.perfAudit}ms a11y=${p.a11yAudit}ms shot=${p.screenshot}ms`);
    } else {
      console.log(`\n  ${icon} ${host}  (${r.durationMs}ms)`);
      console.log(`    Error: ${r.error}`);
    }
  }

  // === SUMMARY ===
  const seqEstimate = results.reduce((sum, r) => sum + r.durationMs, 0);
  const totalHeadings = successes.reduce((s, r) => s + (r.data?.headings.length || 0), 0);
  const totalLinks = successes.reduce((s, r) => s + (r.data?.links.total || 0), 0);
  const totalScreenshotKB = successes.reduce((s, r) => s + (r.data?.screenshotSizeKB || 0), 0);
  const totalDomNodes = successes.reduce((s, r) => s + (r.data?.perf.domNodes || 0), 0);
  const pricingSites = successes.filter(r => r.data?.pricing.found).length;
  const avgPhases = {
    navigate: Math.round(successes.reduce((s, r) => s + r.phases.navigate, 0) / successes.length),
    metaExtract: Math.round(successes.reduce((s, r) => s + r.phases.metaExtract, 0) / successes.length),
    contentExtract: Math.round(successes.reduce((s, r) => s + r.phases.contentExtract, 0) / successes.length),
    techDetect: Math.round(successes.reduce((s, r) => s + r.phases.techDetect, 0) / successes.length),
    perfAudit: Math.round(successes.reduce((s, r) => s + r.phases.perfAudit, 0) / successes.length),
    a11yAudit: Math.round(successes.reduce((s, r) => s + r.phases.a11yAudit, 0) / successes.length),
    screenshot: Math.round(successes.reduce((s, r) => s + r.phases.screenshot, 0) / successes.length),
  };

  console.log('\n' + '═'.repeat(95));
  console.log('  AGGREGATE SUMMARY');
  console.log('═'.repeat(95));

  console.log(`\n⏱️  Performance:`);
  console.log(`   Sites:              ${SITES.length}`);
  console.log(`   Successful:         ${successes.length}`);
  console.log(`   Failed:             ${failures.length}`);
  console.log(`   Parallel total:     ${parallelTotal}ms (${(parallelTotal / 1000).toFixed(1)}s)`);
  console.log(`   Sequential est:     ${seqEstimate}ms (${(seqEstimate / 1000).toFixed(1)}s)`);
  console.log(`   Speedup:            ${(seqEstimate / parallelTotal).toFixed(1)}x`);
  console.log(`   Time saved:         ${((seqEstimate - parallelTotal) / 1000).toFixed(1)}s`);

  console.log(`\n📦 Total Data Extracted:`);
  console.log(`   Headings:           ${totalHeadings}`);
  console.log(`   Links analyzed:     ${totalLinks}`);
  console.log(`   DOM nodes parsed:   ${totalDomNodes.toLocaleString()}`);
  console.log(`   Screenshots:        ${successes.length} (${totalScreenshotKB}KB total)`);
  console.log(`   Pricing detected:   ${pricingSites}/${successes.length} sites`);

  console.log(`\n🔬 7 Extraction Phases (avg per site):`);
  console.log(`   1. Navigate:        ${avgPhases.navigate}ms`);
  console.log(`   2. Meta/SEO:        ${avgPhases.metaExtract}ms`);
  console.log(`   3. Content:         ${avgPhases.contentExtract}ms`);
  console.log(`   4. Tech detect:     ${avgPhases.techDetect}ms`);
  console.log(`   5. Perf audit:      ${avgPhases.perfAudit}ms`);
  console.log(`   6. A11y audit:      ${avgPhases.a11yAudit}ms`);
  console.log(`   7. Screenshot:      ${avgPhases.screenshot}ms`);
  console.log(`   Total extraction:   ${avgPhases.metaExtract + avgPhases.contentExtract + avgPhases.techDetect + avgPhases.perfAudit + avgPhases.a11yAudit + avgPhases.screenshot}ms (post-navigate)`);

  console.log('');
  await browser.disconnect();

  if (successes.length >= 15) {
    console.log('✅ PASS: 20-site complex parallel crawl verified\n');
    process.exit(0);
  } else {
    console.log(`❌ FAIL: Only ${successes.length}/${SITES.length} sites succeeded\n`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
