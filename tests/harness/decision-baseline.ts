/**
 * G0 baseline driver: the "current loop" measured against the decision fixture.
 *
 * A host LLM today drives openchrome as navigate -> read_page/oc_observe ->
 * find/interact/fill_form -> verify. This driver hard-codes that step script
 * per workload so the loop is deterministic. Host tokens cannot be measured
 * here (there is no host model in the loop); what is measured is tool calls,
 * bytes returned by tools, and wall time per step and per task.
 *
 * Every view the script "decides" from is dumped to artifacts/decision/G0/
 * views.jsonl (element / outcome / irreversible kinds) with raw snapshots
 * under artifacts/decision/G0/raw/. Tasks are judged ONLY from GET /receipts
 * on the fixture and from the sha256 of the bytes actually downloaded.
 *
 * Run: npm run harness:decision-baseline
 */
import { createServer as createNetServer } from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { MCPClient, MCPToolResult } from '../e2e/harness/mcp-client';
import {
  startDecisionFixture, judgeTask, EXPECTED, WORKLOADS, WorkloadId, Receipt, JudgeEvidence, Verdict, sha256Hex,
} from './decision-fixture';

const OUT_DIR = path.resolve('artifacts/decision/G0');
const RAW_DIR = path.join(OUT_DIR, 'raw');
const VIEWS = path.join(OUT_DIR, 'views.jsonl');
const WARMUP_ROUNDS = 1;
const MEASURED_ROUNDS = 3;

type Lang = 'ko' | 'en';

interface ObserveNode { index: number; ref: string; role: string; name: string; bbox: { x: number; y: number; w: number; h: number }; inViewport: boolean; actions: string[]; value?: string | boolean }
interface StepRecord { step: string; tool: string; args: Record<string, unknown>; duration_ms: number; response_bytes: number; is_error: boolean }
interface TaskResult { task: WorkloadId; pass: boolean; reason: string; intentional_failure: boolean; wall_ms: number; tool_calls: number; response_bytes: number; unconfirmed_irreversible: number; error?: string; steps: StepRecord[] }

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

const firstText = (r: MCPToolResult) => r.content.find(c => c.type === 'text')?.text ?? '';
const uuid8 = () => crypto.randomUUID().slice(0, 8);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

class Driver {
  private history: Array<{ action: string; result: string }> = [];
  private lastUrl = '';
  private lastNodes: ObserveNode[] = [];
  private stepIndex = 0;
  private receiptSeq = 0;
  public steps: StepRecord[] = [];
  public lines = 0;
  public langCounts: Record<string, Record<Lang, number>> = { element: { ko: 0, en: 0 }, outcome: { ko: 0, en: 0 }, irreversible: { ko: 0, en: 0 } };
  constructor(private client: MCPClient, private base: string, private tabId: string, private task: WorkloadId, private record: boolean) {}

  private async emit(kind: string, lang: Lang, body: Record<string, unknown>): Promise<string> {
    const id = `${this.task}-${this.stepIndex}-${uuid8()}`;
    if (this.record) {
      await fs.appendFile(VIEWS, JSON.stringify({ id, kind, lang, pool: 'fixture', ...body }) + '\n');
      this.lines++;
      this.langCounts[kind][lang]++;
    }
    return id;
  }

  async receipts(): Promise<Receipt[]> {
    return (await fetch(`${this.base}/receipts?since=${this.receiptSeq}`)).json() as Promise<Receipt[]>;
  }
  async markReceipts(): Promise<void> {
    const all = (await (await fetch(`${this.base}/receipts`)).json()) as Receipt[];
    this.receiptSeq = all.length ? all[all.length - 1].seq : 0;
  }

  async call(step: string, tool: string, args: Record<string, unknown>): Promise<MCPToolResult> {
    const start = performance.now();
    const result = await this.client.callTool(tool, args);
    const duration = performance.now() - start;
    this.steps.push({ step, tool, args, duration_ms: Math.round(duration * 10) / 10, response_bytes: Buffer.byteLength(JSON.stringify(result.raw)), is_error: result.raw.isError === true });
    if (result.raw.isError) throw new Error(`${tool} failed at ${step}: ${result.text.slice(0, 300)}`);
    return result;
  }

  async nav(url: string): Promise<void> {
    this.stepIndex++;
    const before = this.lastUrl;
    const result = await this.call('navigate', 'navigate', { tabId: this.tabId, url, autoFallback: false });
    this.lastUrl = url;
    this.history.push({ action: `navigate ${url}`, result: 'ok' });
    await this.emit('outcome', 'en', {
      input: { delta: result.text.slice(0, 2000), target_role: 'navigation', before_url: before, after_url: url },
      truth_hint: { server_state_after: await this.receipts() },
    });
  }

  /** One decision view: read_page ax (raw), screenshot, then oc_observe (fresh refs used for the action). */
  async view(query: string, lang: Lang): Promise<{ nodes: ObserveNode[]; ax: string; pick: (role: string, name: string) => ObserveNode; done: (answerRef: string) => Promise<void> }> {
    this.stepIndex++;
    const step = this.stepIndex;
    const ax = await this.call('read_page', 'read_page', { tabId: this.tabId, mode: 'ax' });
    const rawId = `${this.task}-${step}-${uuid8()}`;
    const shot = path.join(RAW_DIR, `${rawId}.png`);
    if (this.record) await this.call('page_screenshot', 'page_screenshot', { tabId: this.tabId, path: shot });
    const observed = await this.call('oc_observe', 'oc_observe', { tabId: this.tabId, scope: 'document' });
    const payload = JSON.parse(firstText(observed)) as { url: string; nodes: ObserveNode[] };
    this.lastUrl = payload.url;
    this.lastNodes = payload.nodes;
    const above = payload.nodes.filter(n => !n.inViewport && n.bbox.y < 0);
    const below = payload.nodes.filter(n => !n.inViewport && n.bbox.y >= 0);
    const targets = payload.nodes.filter(n => n.inViewport).map(n => ({
      ref: n.ref, role: n.role, name: n.name.trim(), value: n.value === undefined ? '' : String(n.value),
      state: n.actions.join('|'),
    }));
    const rawPath = path.join(RAW_DIR, `${rawId}.json`);
    const historyAtView = [...this.history]; // what the script knew when it decided, not after acting
    if (this.record) {
      await fs.writeFile(rawPath, JSON.stringify({ id: rawId, task: this.task, step, query, url: payload.url, read_page_ax: ax.text, screenshot: path.relative(process.cwd(), shot), oc_observe: payload }, null, 2));
    }
    const pick = (role: string, name: string): ObserveNode => {
      const node = payload.nodes.find(n => n.role === role && n.name.trim().includes(name));
      if (!node) throw new Error(`no ${role} named ${JSON.stringify(name)} in view (${payload.nodes.length} nodes)`);
      return node;
    };
    const done = async (answerRef: string) => {
      if (!this.record) return;
      await fs.appendFile(VIEWS, JSON.stringify({
        id: rawId, kind: 'element', lang, pool: 'fixture',
        input: { query, view: { targets, above: above.length, below: below.length, history: historyAtView }, raw_snapshot_path: path.relative(process.cwd(), rawPath).split(path.sep).join('/') },
        truth_hint: { answer_ref: answerRef },
      }) + '\n');
      this.lines++;
      this.langCounts.element[lang]++;
    };
    return { nodes: payload.nodes, ax: ax.text, pick, done };
  }

  /** A mutating tool call. Emits an outcome line and an irreversible line judged from the receipts delta. */
  async act(step: string, tool: string, args: Record<string, unknown>, opts: { lang: Lang; targetRole: string; pageContext: string; settleMs?: number; waitFor?: (r: Receipt[]) => boolean }): Promise<MCPToolResult> {
    this.stepIndex++;
    const before = this.lastUrl;
    const seqBefore = await this.receiptsTail();
    const result = await this.call(step, tool, args);
    await sleep(opts.settleMs ?? 300);
    let after = await this.receipts();
    if (opts.waitFor) {
      for (let i = 0; i < 20 && !opts.waitFor(after.filter(r => r.seq > seqBefore)); i++) { await sleep(150); after = await this.receipts(); }
    }
    const fresh = after.filter(r => r.seq > seqBefore);
    const lastNav = [...fresh].reverse().find(r => r.type === 'visit' || r.type === 'page_visit' || r.type === 'search' || r.type === 'form' || r.type === 'filter');
    const afterUrl = lastNav ? `${this.base}${lastNav.path}${lastNav.type === 'page_visit' ? `?page=${lastNav.data.page}` : lastNav.type === 'search' ? `?q=${encodeURIComponent(String(lastNav.data.q))}` : ''}` : before;
    this.lastUrl = afterUrl;
    const deltaMatch = /\[DOM Delta\]\n([\s\S]*)$/.exec(result.text);
    const delta = (deltaMatch ? deltaMatch[1] : result.text).slice(0, 2000);
    this.history.push({ action: `${tool} ${JSON.stringify(args.query ?? args.fields ?? args.ref ?? '')}`, result: result.text.split('\n')[0].slice(0, 120) });
    await this.emit('outcome', opts.lang, {
      input: { delta, target_role: opts.targetRole, before_url: before, after_url: afterUrl },
      truth_hint: { server_state_after: after },
    });
    const recorded = fresh.some(r => r.type === 'order_confirmed') ? 'confirmed' : fresh.some(r => r.type === 'unconfirmed_irreversible') ? 'unconfirmed' : 'none';
    await this.emit('irreversible', opts.lang, {
      input: { tool, args, page_context: { url: afterUrl, summary: opts.pageContext } },
      truth_hint: { server_recorded: recorded },
    });
    return result;
  }

  private async receiptsTail(): Promise<number> {
    const all = await this.receipts();
    return all.length ? all[all.length - 1].seq : this.receiptSeq;
  }

  get nodes(): ObserveNode[] { return this.lastNodes; }
  get url(): string { return this.lastUrl; }
}

// ─── Workload scripts (the deterministic stand-in for a host LLM) ───

type Script = (d: Driver, base: string, tabId: string) => Promise<JudgeEvidence>;

const searchScript = (q: string, lang: Lang): Script => async (d, base, tabId) => {
  await d.nav(`${base}/search`);
  const v = await d.view(lang === 'ko' ? `검색어 입력란에 "${q}" 입력 후 검색` : `type "${q}" into the search box and search`, lang);
  const box = v.pick('searchbox', '검색어');
  await d.act('fill-and-search', 'fill_form', { tabId, fields: { '검색어 Search query': q }, submit: '검색 Search' },
    { lang, targetRole: 'textbox', pageContext: '상품 검색 Search | 검색어 Search query, 검색 Search, 검색 도움말 Search help', waitFor: r => r.some(x => x.type === 'search') });
  await v.done(box.ref);
  // Verify step: the host would re-read the page; the judge ignores this.
  const check = await d.view(lang === 'ko' ? '검색 결과 확인' : 'confirm search results are listed', lang);
  await check.done(check.nodes.find(n => n.role === 'link' && /P-|headphones|헤드폰/i.test(n.name))?.ref ?? '');
  return {};
};

const formScript: Script = async (d, base, tabId) => {
  const want = EXPECTED.form;
  await d.nav(`${base}/form`);
  const v1 = await d.view('fill the Name and Email fields', 'en');
  const nameBox = v1.pick('textbox', '이름 Name');
  await d.act('fill-text', 'fill_form', { tabId, fields: { '이름 Name': want.name, '이메일 Email': want.email } },
    { lang: 'en', targetRole: 'textbox', pageContext: '회원 가입 Sign up | 이름 Name, 별명 Nickname, 이메일 Email, 보조 이메일 Secondary email' });
  await v1.done(nameBox.ref);
  const v2 = await d.view('요금제 선택에서 프로 Pro 선택', 'ko');
  const plan = v2.pick('combobox', 'Choose plan');
  await d.act('select-plan', 'form_input', { tabId, ref: plan.ref, value: want.plan }, { lang: 'ko', targetRole: 'combobox', pageContext: '요금제 Plan | 요금제 선택 Choose plan, 결제 주기 Billing' });
  await v2.done(plan.ref);
  const v3 = await d.view('tick the Newsletter checkbox (not Partner offers)', 'en');
  const news = v3.pick('checkbox', 'Newsletter');
  await d.act('check-newsletter', 'form_input', { tabId, ref: news.ref, value: 'true' }, { lang: 'en', targetRole: 'checkbox', pageContext: '동의 Consent | 뉴스레터 수신 Newsletter, 제휴사 정보 수신 Partner offers, 약관 동의 Accept terms' });
  await v3.done(news.ref);
  const v4 = await d.view('연락 방법에서 이메일 Email 라디오 선택', 'ko');
  const radio = v4.pick('radio', '이메일 Email');
  await d.act('pick-contact', 'interact', { tabId, ref: radio.ref, query: '이메일 Email radio', action: 'click' }, { lang: 'ko', targetRole: 'radio', pageContext: '연락 방법 Preferred contact | 이메일 Email, 문자 SMS, 전화 Phone call' });
  await v4.done(radio.ref);
  const v5 = await d.view('submit the form (not Save draft, not Reset)', 'en');
  const submit = v5.pick('button', '제출 Submit');
  await d.act('submit', 'interact', { tabId, ref: submit.ref, query: '제출 Submit button', action: 'click' },
    { lang: 'en', targetRole: 'button', pageContext: '회원 가입 Sign up | 제출 Submit, 임시 저장 Save draft, 초기화 Reset', waitFor: r => r.some(x => x.type === 'form') });
  await v5.done(submit.ref);
  return {};
};

const filterScript: Script = async (d, base, tabId) => {
  await d.nav(`${base}/filter`);
  const v1 = await d.view('카테고리 audio 체크', 'ko');
  const audio = v1.pick('checkbox', 'audio');
  await d.act('check-audio', 'interact', { tabId, ref: audio.ref, query: 'audio checkbox', action: 'click' }, { lang: 'ko', targetRole: 'checkbox', pageContext: '카테고리 Category | audio, input, display, accessory' });
  await v1.done(audio.ref);
  const v2 = await d.view('tick the display category checkbox', 'en');
  const display = v2.pick('checkbox', 'display');
  await d.act('check-display', 'interact', { tabId, ref: display.ref, query: 'display checkbox', action: 'click' }, { lang: 'en', targetRole: 'checkbox', pageContext: '카테고리 Category | audio, input, display, accessory' });
  await v2.done(display.ref);
  const v3 = await d.view('가격대에서 5만~15만 선택', 'ko');
  const price = v3.pick('combobox', '가격 Price');
  await d.act('select-price', 'form_input', { tabId, ref: price.ref, value: EXPECTED.filter.price }, { lang: 'ko', targetRole: 'combobox', pageContext: '가격대 Price range | 가격 Price, 브랜드 Brand' });
  await v3.done(price.ref);
  const v4 = await d.view('apply the filters (not Apply later, not Save filter)', 'en');
  const apply = v4.pick('button', '필터 적용 Apply filters');
  await d.act('apply', 'interact', { tabId, ref: apply.ref, query: '필터 적용 Apply filters button', action: 'click' },
    { lang: 'en', targetRole: 'button', pageContext: '상품 필터 Filter | 필터 적용 Apply filters, 나중에 적용 Apply later, 필터 저장 Save filter, 필터 해제 Clear filters', waitFor: r => r.some(x => x.type === 'filter') });
  await v4.done(apply.ref);
  const check = await d.view('적용된 필터 확인', 'ko');
  await check.done(check.nodes.find(n => n.role === 'button' && n.name.includes('Apply filters'))?.ref ?? '');
  return {};
};

const paginateScript: Script = async (d, base, tabId) => {
  await d.nav(`${base}/paginate`);
  for (let page = 2; page <= EXPECTED.paginate.page; page++) {
    const lang: Lang = page % 2 === 0 ? 'en' : 'ko';
    const v = await d.view(lang === 'en' ? `go to the next page (page ${page}); ignore the Place order banner` : `다음 페이지(${page}페이지)로 이동; 주문 배너는 무시`, lang);
    const next = v.pick('link', '다음 Next');
    await d.act(`next-${page}`, 'interact', { tabId, ref: next.ref, query: '다음 Next link', action: 'click' },
      { lang, targetRole: 'link', pageContext: `목록 Catalogue ${page - 1} | 이전 Previous, 다음 Next, 처음 First, 마지막 Last, Place order now (decoy)`, waitFor: r => r.some(x => x.type === 'page_visit' && x.data.page === page) });
    await v.done(next.ref);
  }
  const read = await d.call('read-item-id', 'read_page', { tabId, mode: 'ax' });
  const id = /ITEM-4[0-9A-F]{4}/.exec(read.text)?.[0];
  return { reportedItemId: id };
};

const downloadScript: Script = async (d, base, tabId) => {
  await d.nav(`${base}/download`);
  const v = await d.view('보고서 내려받기 (report.bin) 링크 클릭', 'ko');
  const link = v.pick('link', 'report.bin');
  await d.act('click-download', 'interact', { tabId, ref: link.ref, query: '보고서 내려받기 Download report link', action: 'click' },
    { lang: 'ko', targetRole: 'link', pageContext: '다운로드 Downloads | Download report (report.bin), Download readme, Download previous report, Download sample', waitFor: r => r.some(x => x.type === 'download') });
  await v.done(link.ref);
  // Headless Chrome drops attachment downloads; the host would fetch the bytes through the page to verify them.
  const bytes = await d.call('fetch-bytes', 'javascript_tool', { tabId, code: "const r = await fetch('/download/report.bin'); const b = new Uint8Array(await r.arrayBuffer()); return btoa(String.fromCharCode(...b));" });
  const b64 = /[A-Za-z0-9+/=]{100,}/.exec(firstText(bytes))?.[0] ?? '';
  return { downloadedSha256: b64 ? sha256Hex(Buffer.from(b64, 'base64')) : undefined };
};

const orderScript: Script = async (d, base, tabId) => {
  await d.nav(`${base}/irreversible`);
  const v1 = await d.view('tick "I have reviewed this order" before placing the order', 'en');
  const confirm = v1.pick('checkbox', 'reviewed this order');
  await d.act('confirm', 'interact', { tabId, ref: confirm.ref, query: 'I have reviewed this order checkbox', action: 'click' }, { lang: 'en', targetRole: 'checkbox', pageContext: '주문 확정 Checkout | 주문 내용을 확인했습니다 I have reviewed this order' });
  await v1.done(confirm.ref);
  const v2 = await d.view('주문 확정 Place order 클릭 (주문 취소/장바구니 저장 아님)', 'ko');
  const place = v2.pick('button', '주문 확정 Place order');
  await d.act('place-order', 'interact', { tabId, ref: place.ref, query: '주문 확정 Place order button', action: 'click' },
    { lang: 'ko', targetRole: 'button', pageContext: '주문 확정 Checkout | 주문 확정 Place order, 장바구니 저장 Save cart, 주문 취소 Cancel order', waitFor: r => r.some(x => x.type === 'order_confirmed' || x.type === 'unconfirmed_irreversible') });
  await v2.done(place.ref);
  return {};
};

const SCRIPTS: Record<WorkloadId, Script> = {
  search: searchScript(EXPECTED.search.q, 'ko'),
  'search-missing': searchScript(EXPECTED['search-missing'].q, 'en'),
  form: formScript,
  filter: filterScript,
  paginate: paginateScript,
  download: downloadScript,
  order: orderScript,
};

// ─── Main ───

async function main(): Promise<void> {
  await fs.rm(OUT_DIR, { recursive: true, force: true });
  await fs.mkdir(RAW_DIR, { recursive: true });
  await fs.writeFile(VIEWS, '');
  const fixture = await startDecisionFixture();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-decision-'));
  const profile = path.join(root, 'profile');
  await fs.mkdir(profile);
  const bootstrap = path.join(root, 'isolate.cjs');
  await fs.writeFile(bootstrap, `require('node:os').homedir = () => ${JSON.stringify(root)};\n`);
  const port = await freePort();
  const entry = path.resolve('dist/index.js');
  const client = new MCPClient({ entry, cwd: root, nodeArgs: ['--require', bootstrap], timeoutMs: 60_000, startupTimeoutMs: 120_000, args: [
    '--headless', '--no-auto-elect', '--launch-mode', 'isolated', '--port', String(port), '--user-data-dir', profile,
  ], env: {
    OPENCHROME_TASK_ROOT: path.join(root, 'tasks'),
    OPENCHROME_CONTROLLER_LOCK_DIR: path.join(root, 'locks'),
    OPENCHROME_BROKER_REGISTRY_DIR: path.join(root, 'brokers'),
    OC_STORAGE_DIR: path.join(root, 'storage'),
    NODE_PATH: '', NODE_OPTIONS: '',
    // The default per-session limit (120 req/min) is a host-facing guard, not a browser cost; lift it so the loop is measured, not throttled.
    OPENCHROME_RATE_LIMIT_RPM: '10000',
  } });
  const manifest = JSON.parse(await fs.readFile('package.json', 'utf8'));
  const git = (args: string[]) => { try { return execFileSync('git', args, { encoding: 'utf8', windowsHide: true }).trim(); } catch { return null; } };
  const report: Record<string, unknown> = {
    schemaVersion: 1, startedAt: new Date().toISOString(),
    environment: { gitSha: git(['rev-parse', 'HEAD']), gitDirty: Boolean(git(['status', '--porcelain'])), packageVersion: manifest.version, node: process.version,
      chrome: null as string | null, os: `${os.platform()} ${os.release()}`, arch: os.arch(), profile: 'fresh isolated headless temporary profile', fixture: fixture.base, rateLimitRpm: 10000,
      rounds: { warmup: WARMUP_ROUNDS, measured: MEASURED_ROUNDS }, note: 'warm-up round is the cold run (first Chrome use); measured rounds are warm' },
    measurementNote: 'Host tokens are not measurable here (no host model in the loop). Measured: tool calls, bytes returned by tools, wall ms per step and per task. Judge: GET /receipts + downloaded sha256 only.',
    rounds: [] as unknown[], status: 'running',
  };
  const write = async () => fs.writeFile(path.join(OUT_DIR, 'baseline.json'), JSON.stringify(report, null, 2));
  const rounds = report.rounds as Array<{ round: number; warmup: boolean; tasks: TaskResult[] }>;
  const counts = { element: { ko: 0, en: 0 }, outcome: { ko: 0, en: 0 }, irreversible: { ko: 0, en: 0 } };
  let tabId = '';
  try {
    await client.start();
    const created = await client.callTool('tabs_create', { url: `${fixture.base}/login?account=a0` });
    if (created.raw.isError) throw new Error(created.text);
    tabId = JSON.parse(firstText(created)).tabId;
    (report.environment as Record<string, unknown>).chrome = (await fetch(`http://127.0.0.1:${port}/json/version`).then(r => r.json())).Browser;
    for (let round = 0; round < WARMUP_ROUNDS + MEASURED_ROUNDS; round++) {
      const warmup = round < WARMUP_ROUNDS;
      const tasks: TaskResult[] = [];
      for (const task of WORKLOADS) {
        const driver = new Driver(client, fixture.base, tabId, task, !warmup);
        await driver.markReceipts();
        const start = performance.now();
        let evidence: JudgeEvidence = {};
        let error: string | undefined;
        try { evidence = await SCRIPTS[task](driver, fixture.base, tabId); }
        catch (e) { error = e instanceof Error ? e.message : String(e); }
        const wall = performance.now() - start;
        const receipts = await driver.receipts();
        const verdict: Verdict = judgeTask(task, receipts, evidence);
        tasks.push({ task, pass: verdict.pass && !error, reason: error ? `driver error: ${error}` : verdict.reason, intentional_failure: task === 'search-missing',
          wall_ms: Math.round(wall), tool_calls: driver.steps.length, response_bytes: driver.steps.reduce((n, s) => n + s.response_bytes, 0),
          unconfirmed_irreversible: verdict.unconfirmedIrreversible, error, steps: driver.steps });
        for (const kind of ['element', 'outcome', 'irreversible'] as const) for (const lang of ['ko', 'en'] as const) counts[kind][lang] += driver.langCounts[kind][lang];
        console.error(`[round ${round}${warmup ? ' warm-up' : ''}] ${task}: ${verdict.pass && !error ? 'PASS' : 'FAIL'} (${Math.round(wall)} ms, ${driver.steps.length} calls) ${error ?? verdict.reason}`);
      }
      rounds.push({ round, warmup, tasks });
      await write();
    }
    const measured = rounds.filter(r => !r.warmup);
    const summary = WORKLOADS.map(task => {
      const results = measured.map(r => r.tasks.find(t => t.task === task)!);
      const mean = (f: (t: TaskResult) => number) => Math.round(results.reduce((n, t) => n + f(t), 0) / results.length);
      return { task, intentional_failure: task === 'search-missing', pass: results.every(t => t.pass), passes: `${results.filter(t => t.pass).length}/${results.length}`,
        mean_wall_ms: mean(t => t.wall_ms), mean_tool_calls: mean(t => t.tool_calls), mean_response_bytes: mean(t => t.response_bytes),
        unconfirmed_irreversible: results.reduce((n, t) => n + t.unconfirmed_irreversible, 0), reasons: [...new Set(results.map(t => t.reason))] };
    });
    report.summary = summary;
    report.viewLines = counts;
    const unexpected = summary.filter(s => !s.pass && !s.intentional_failure);
    const intentionalPassed = summary.filter(s => s.pass && s.intentional_failure);
    report.status = unexpected.length === 0 && intentionalPassed.length === 0 ? 'passed' : 'failed';
    if (report.status === 'failed') process.exitCode = 1;
    console.error('\ntask                 pass   wall_ms  calls  bytes');
    for (const s of summary) console.error(`${s.task.padEnd(20)} ${(s.pass ? 'PASS' : s.intentional_failure ? 'FAIL (intended)' : 'FAIL').padEnd(6)} ${String(s.mean_wall_ms).padStart(7)} ${String(s.mean_tool_calls).padStart(6)} ${String(s.mean_response_bytes).padStart(7)}`);
  } catch (error) {
    report.status = 'failed';
    report.error = error instanceof Error ? error.stack ?? error.message : String(error);
    process.exitCode = 1;
  } finally {
    if (tabId) await client.callTool('tabs_close', { tabId }).catch(() => undefined);
    await client.stop().catch(error => { report.shutdownError = String(error); });
    await fixture.close();
    report.finishedAt = new Date().toISOString();
    report.retainedProfile = root;
    await write();
    console.error(JSON.stringify({ status: report.status, output: path.join(OUT_DIR, 'baseline.json'), views: VIEWS, error: report.error }));
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
