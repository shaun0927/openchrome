import * as fs from 'fs';
import * as path from 'path';
import type { EpisodeEvent, EpisodeResult } from './types';

export interface EpisodeReportPaths {
  eventsJsonl: string;
  reportJson: string;
  reportMarkdown: string;
}

export function ensureReportDirs(outDir: string): { eventsDir: string; reportsDir: string } {
  const eventsDir = path.join(outDir, 'events');
  const reportsDir = path.join(outDir, 'reports');
  fs.mkdirSync(eventsDir, { recursive: true });
  fs.mkdirSync(reportsDir, { recursive: true });
  return { eventsDir, reportsDir };
}

export function writeEpisodeArtifacts(outDir: string, runId: string, events: EpisodeEvent[], result: EpisodeResult): EpisodeReportPaths {
  const { eventsDir, reportsDir } = ensureReportDirs(outDir);
  const eventsJsonl = path.join(eventsDir, `${runId}.jsonl`);
  const reportJson = path.join(reportsDir, `${runId}.json`);
  const reportMarkdown = path.join(reportsDir, `${runId}.md`);
  fs.writeFileSync(eventsJsonl, events.map(event => JSON.stringify(event)).join('\n') + '\n');
  fs.writeFileSync(reportJson, JSON.stringify(result, null, 2) + '\n');
  fs.writeFileSync(reportMarkdown, renderMarkdown(result));
  fs.writeFileSync(path.join(reportsDir, 'latest.json'), JSON.stringify(result, null, 2) + '\n');
  fs.writeFileSync(path.join(reportsDir, 'latest.md'), renderMarkdown(result));
  return { eventsJsonl, reportJson, reportMarkdown };
}

export function renderMarkdown(result: EpisodeResult): string {
  return [
    `# Episode ${result.taskId}`,
    '',
    `- Status: ${result.status}`,
    `- Success: ${result.success}`,
    `- Steps: ${result.steps}`,
    `- Tool calls: ${result.toolCalls}`,
    `- OpenChrome errors: ${result.openchromeErrors}`,
    `- No-progress episodes: ${result.noProgressEpisodes}`,
    `- Total tokens: ${result.tokenUsage.totalTokens}`,
    `- Tool result tokens: ${result.tokenUsage.toolResultTokens}`,
    `- Tool request tokens: ${result.tokenUsage.toolRequestTokens}`,
    `- Contract tokens: ${result.tokenUsage.contractTokens}`,
    `- Prompt tokens: ${result.tokenUsage.promptTokens}`,
    `- Duration: ${result.durationMs} ms`,
    `- Final URL: ${result.finalUrl}`,
    `- Events: ${result.artifacts.eventsJsonl}`,
    '',
    result.failedContract ? '## Failed contract\n\n```json\n' + JSON.stringify(result.failedContract, null, 2) + '\n```\n' : '',
  ].join('\n');
}
