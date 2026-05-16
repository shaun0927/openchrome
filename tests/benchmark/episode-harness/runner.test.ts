import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MockEpisodeAdapter } from './mock-adapter';
import { MockOpenChromeClient } from './mock-client';
import { fixtureTasks } from './fixtures/tasks';
import { normalizeTaskSpec } from './spec';
import { countNoProgressEpisodes, runEpisode } from './runner';
import { estimateToolRequestTokens, summarizeEpisodeTokens } from './token-accounting';

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'episode-harness-'));
}

describe('episode harness spec validation', () => {
  it('applies bounded defaults', () => {
    const task = normalizeTaskSpec({
      id: 'minimal',
      title: 'Minimal',
      startUrl: 'mock://example',
      goal: 'Read example',
      success: { kind: 'dom_text', contains: 'Example Domain' },
    });
    expect(task.maxSteps).toBe(30);
    expect(task.maxDurationMs).toBe(120_000);
  });

  it('rejects unknown task fields', () => {
    expect(() => normalizeTaskSpec({
      id: 'bad',
      title: 'Bad',
      startUrl: 'mock://example',
      goal: 'Nope',
      success: { kind: 'dom_text', contains: 'Example Domain' },
      llmProvider: 'forbidden',
    })).toThrow(/unknown field/);
  });

  it('rejects unsupported assertion shapes', () => {
    expect(() => normalizeTaskSpec({
      id: 'bad-assert',
      title: 'Bad assertion',
      startUrl: 'mock://example',
      goal: 'Nope',
      success: { kind: 'made_up', value: true },
    })).toThrow(/unsupported assertion/);
  });

  it('rejects non-positive budgets', () => {
    expect(() => normalizeTaskSpec({
      ...fixtureTasks[0],
      maxSteps: 0,
    })).toThrow(/maxSteps/);
  });
});

describe('runEpisode', () => {
  it('passes deterministic read-only fixture and writes artifacts', async () => {
    const outDir = tmpdir();
    const { result, events } = await runEpisode(fixtureTasks[0], new MockEpisodeAdapter(), new MockOpenChromeClient(), { outDir, runId: 'read-fixture' });

    expect(result.status).toBe('passed');
    expect(result.success).toBe(true);
    expect(result.toolCalls).toBeGreaterThanOrEqual(1);
    expect(result.openchromeErrors).toBe(0);
    expect(result.tokenUsage.totalTokens).toBeGreaterThan(0);
    expect(result.tokenUsage.toolRequestTokens).toBeGreaterThan(0);
    expect(result.tokenUsage.toolResultTokens).toBeGreaterThan(0);
    expect(events.some(event => event.type === 'contract_eval')).toBe(true);
    expect(fs.existsSync(result.artifacts.eventsJsonl)).toBe(true);
    expect(fs.existsSync(result.artifacts.reportJson)).toBe(true);
  });

  it('runs form fixture through deterministic mock tool calls', async () => {
    const { result } = await runEpisode(fixtureTasks[1], new MockEpisodeAdapter(), new MockOpenChromeClient(), { outDir: tmpdir(), runId: 'form-fixture' });

    expect(result.status).toBe('passed');
    expect(result.steps).toBe(4);
    expect(result.finalUrl).toBe('mock://form');
  });

  it('reports max_steps and failed contract evidence for stalled fixture', async () => {
    const { result } = await runEpisode({ ...fixtureTasks[2], maxSteps: 3 }, new MockEpisodeAdapter(), new MockOpenChromeClient(), { outDir: tmpdir(), runId: 'stall-fixture' });

    expect(result.status).toBe('max_steps');
    expect(result.success).toBe(false);
    expect(result.steps).toBe(3);
    expect(result.noProgressEpisodes).toBeGreaterThanOrEqual(1);
    expect(result.failedContract).toEqual(expect.objectContaining({ assertion_kind: 'dom_text' }));
  });

  it('summarizes stable token accounting for episode events', () => {
    const task = normalizeTaskSpec(fixtureTasks[0]);
    const usage = summarizeEpisodeTokens(task, [
      { ts: 1, type: 'tool_call', tool: 'read_page', args: {} },
      { ts: 2, type: 'tool_result', tool: 'read_page', ok: true, text: 'Example Domain' },
    ]);

    expect(usage.promptTokens).toBeGreaterThan(0);
    expect(usage.toolRequestTokens).toBe(estimateToolRequestTokens({ tool: 'read_page', args: {} }));
    expect(usage.toolResultTokens).toBeGreaterThan(0);
    expect(usage.totalTokens).toBe(usage.promptTokens + usage.toolRequestTokens + usage.toolResultTokens + usage.contractTokens + usage.responseTokens);
  });

  it('counts repeated successful calls as one no-progress episode', () => {
    expect(countNoProgressEpisodes([
      { ts: 1, type: 'tool_result', tool: 'read_page', ok: true, text: 'same' },
      { ts: 2, type: 'tool_result', tool: 'read_page', ok: true, text: 'same' },
      { ts: 3, type: 'tool_result', tool: 'read_page', ok: true, text: 'same' },
      { ts: 4, type: 'tool_result', tool: 'read_page', ok: true, text: 'same' },
    ])).toBe(1);
  });
});
