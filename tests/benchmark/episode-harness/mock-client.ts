import type { Assertion, EvaluationResult, Evidence } from '../../../src/contracts/types';
import type { EpisodeClient, EpisodeToolCall, EpisodeToolResult, NormalizedEpisodeTaskSpec } from './types';

interface PageState {
  url: string;
  title: string;
  text: string;
  counts: Record<string, number>;
  formSubmitted?: boolean;
}

const PAGES: Record<string, PageState> = {
  'mock://example': {
    url: 'mock://example',
    title: 'Example Domain',
    text: 'Example Domain This domain is for use in illustrative examples.',
    counts: { h1: 1, form: 0, '.success': 0 },
  },
  'mock://form': {
    url: 'mock://form',
    title: 'Local form',
    text: 'Name Email Submit',
    counts: { h1: 1, form: 1, '.success': 0 },
  },
  'mock://stall': {
    url: 'mock://stall',
    title: 'Recovery stall',
    text: 'Keep trying will not change this page.',
    counts: { h1: 1, '.success': 0 },
  },
};

export class MockOpenChromeClient implements EpisodeClient {
  private page: PageState = { ...PAGES['mock://example'] };
  private fields = new Map<string, string>();

  async reset(task: NormalizedEpisodeTaskSpec): Promise<void> {
    this.fields.clear();
    this.page = clonePage(PAGES[task.startUrl] ?? {
      url: task.startUrl,
      title: task.title,
      text: '',
      counts: {},
    });
  }

  async callTool(call: EpisodeToolCall): Promise<EpisodeToolResult> {
    switch (call.tool) {
      case 'navigate': {
        const url = String(call.args.url ?? '');
        this.page = clonePage(PAGES[url] ?? { url, title: url, text: '', counts: {} });
        return { ok: true, text: `navigated ${url}`, data: { url } };
      }
      case 'read_page':
      case 'tabs_context':
        return { ok: true, text: `${this.page.title}\n${this.page.text}`, data: { url: this.page.url, title: this.page.title } };
      case 'form_input': {
        const selector = String(call.args.selector ?? call.args.ref ?? 'field');
        const value = String(call.args.value ?? '');
        this.fields.set(selector, value);
        return { ok: true, text: `filled ${selector}` };
      }
      case 'interact':
      case 'click': {
        const target = String(call.args.selector ?? call.args.ref ?? call.args.text ?? '');
        if (this.page.url === 'mock://form' && /submit/i.test(target)) {
          this.page.formSubmitted = true;
          this.page.text = 'Form submitted successfully';
          this.page.counts['.success'] = 1;
          return { ok: true, text: 'submitted form' };
        }
        return { ok: false, error: `No actionable element matched ${target}` };
      }
      case 'oc_progress_status':
        return { ok: true, text: 'unknown', data: { status: 'unknown' } };
      default:
        return { ok: false, error: `Unsupported mock tool: ${call.tool}` };
    }
  }

  async evaluate(assertion: Assertion): Promise<EvaluationResult> {
    return evaluateAssertion(assertion, this.page);
  }

  async currentUrl(): Promise<string> {
    return this.page.url;
  }
}

function clonePage(page: PageState): PageState {
  return { ...page, counts: { ...page.counts } };
}

function evaluateAssertion(assertion: Assertion, page: PageState): EvaluationResult {
  switch (assertion.kind) {
    case 'url': {
      const passed = new RegExp(assertion.pattern).test(page.url);
      return result(passed, 'url', { observed: page.url, pattern: assertion.pattern });
    }
    case 'dom_text': {
      const passed = page.text.includes(assertion.contains);
      return result(passed, 'dom_text', { selector: assertion.selector ?? 'body', observed: page.text.slice(0, 200), contains: assertion.contains });
    }
    case 'dom_count': {
      const observed = page.counts[assertion.selector] ?? 0;
      const passed = assertion.op === 'eq' ? observed === assertion.value : assertion.op === 'gte' ? observed >= assertion.value : observed <= assertion.value;
      return result(passed, 'dom_count', { selector: assertion.selector, observed, op: assertion.op, expected: assertion.value });
    }
    case 'and': {
      const children = assertion.children.map(child => evaluateAssertion(child, page));
      const passed = children.every(child => child.passed);
      return result(passed, 'and', { children });
    }
    case 'or': {
      const children = assertion.children.map(child => evaluateAssertion(child, page));
      const passed = children.some(child => child.passed);
      return result(passed, 'or', { children });
    }
    case 'not': {
      const child = evaluateAssertion(assertion.child, page);
      return result(!child.passed, 'not', { child });
    }
    default:
      return result(false, assertion.kind, { error: `unsupported mock assertion ${assertion.kind}` });
  }
}

function result(passed: boolean, assertionKind: Evidence['assertion_kind'], details: Record<string, unknown>): EvaluationResult {
  return {
    passed,
    evidence: {
      passed,
      assertion_kind: assertionKind,
      details,
    },
  };
}
