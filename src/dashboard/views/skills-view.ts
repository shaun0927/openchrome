/**
 * Skills View — read-only ANSI rendering of the skill memory store (#865).
 *
 * Walks `~/.openchrome/skill-memory/<encodedDomain>/skills.json` for all
 * known domains and surfaces each skill row with its replay signal
 * (from #856 if present). Strictly read-only.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { ANSI, BOX, horizontalLine, pad, truncate } from '../ansi.js';
import type { ScreenSize } from '../types.js';
import { Renderer } from '../renderer.js';
import { SkillMemoryStore } from '../../core/skill-memory/index.js';
import type { SkillRecord } from '../../core/skill-memory/index.js';

export interface SkillRow {
  domain: string;
  skill: SkillRecord;
}

export interface SkillsViewData {
  rows: SkillRow[];
  version: string;
  errorMessage?: string;
}

function colorize(text: string, code: string | undefined): string {
  if (!code) return text;
  return code + text + ANSI.reset;
}

export class SkillsView {
  private renderer: Renderer;

  constructor(renderer: Renderer) {
    this.renderer = renderer;
  }

  render(data: SkillsViewData, size: ScreenSize): string[] {
    const lines: string[] = [];
    const width = size.columns;

    lines.push(this.renderer.header('Skill Ledger', width));
    lines.push(this.renderColumnHeaders(width));
    lines.push(BOX.teeRight + horizontalLine(width - 2) + BOX.teeLeft);

    if (data.errorMessage) {
      lines.push(this.renderer.contentLine(colorize(`error: ${data.errorMessage}`, ANSI.red), width));
    } else if (data.rows.length === 0) {
      lines.push(
        this.renderer.contentLine(
          colorize('(no skills recorded — write some via oc_skill_record)', ANSI.dim),
          width,
        ),
      );
    } else {
      const visibleRows = Math.max(0, size.rows - 7);
      for (const r of data.rows.slice(0, visibleRows)) {
        lines.push(this.renderSkillRow(r, width));
      }
    }

    while (lines.length < size.rows - 2) {
      lines.push(this.renderer.emptyLine(width));
    }

    lines.push(BOX.teeRight + horizontalLine(width - 2) + BOX.teeLeft);
    lines.push(
      this.renderer.contentLine(colorize('esc: back  q: quit  (read-only view)', ANSI.dim), width),
    );
    lines.push(this.renderer.footer(width));
    return lines;
  }

  private renderColumnHeaders(width: number): string {
    const header = colorize(
      pad('domain', 24) +
        ' ' +
        pad('name', 22) +
        ' ' +
        pad('used', 6) +
        ' ' +
        pad('replay', 8) +
        ' ' +
        'last_used',
      ANSI.bold,
    );
    return this.renderer.contentLine(header, width);
  }

  private renderSkillRow(r: SkillRow, width: number): string {
    const replay = computeReplayBadge(r.skill);
    const lastUsed =
      r.skill.lastUsedAt > 0 ? formatRelative(Date.now() - r.skill.lastUsedAt) : '—';
    const row =
      pad(truncate(r.domain, 24), 24) +
      ' ' +
      pad(truncate(r.skill.name, 22), 22) +
      ' ' +
      pad(String(r.skill.successCount), 6) +
      ' ' +
      pad(replay, 8) +
      ' ' +
      lastUsed;
    return this.renderer.contentLine(row, width);
  }
}

/**
 * Read the optional replay-outcome timestamps without assuming the fields
 * exist on the SkillRecord type. The replay path (#856) adds these fields
 * but lands as a separate PR — when this PR is stacked on A (#855) only,
 * the fields are not yet on the type. Once #856 is in develop, the cast
 * becomes redundant and can be removed.
 */
function computeReplayBadge(s: SkillRecord): string {
  const replay = s as SkillRecord & {
    lastReplayPassedAt?: number;
    lastReplayFailedAt?: number;
  };
  const passed = replay.lastReplayPassedAt ?? 0;
  const failed = replay.lastReplayFailedAt ?? 0;
  if (passed === 0 && failed === 0) return colorize('—', ANSI.dim);
  if (passed > failed) return colorize('PASS', ANSI.green);
  if (failed > passed) return colorize('FAIL', ANSI.red);
  return colorize('—', ANSI.dim);
}

function formatRelative(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 60000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ago`;
  if (ms < 86400000) return `${Math.floor(ms / 3600000)}h ago`;
  return `${Math.floor(ms / 86400000)}d ago`;
}

/**
 * Walk the default skill-memory rootDir and return a flat skill row
 * list. Read-only; any IO error is captured in `errorMessage` rather
 * than thrown.
 */
export async function readSkillsSnapshot(): Promise<SkillsViewData> {
  const root = join(homedir(), '.openchrome', 'skill-memory');
  try {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        return { rows: [], version: '1' };
      }
      throw e;
    }

    const rows: SkillRow[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const encodedDomain = entry.name;
      const domain = encodedDomain;
      try {
        const store = new SkillMemoryStore({ domain });
        for (const skill of store.list({})) {
          rows.push({ domain, skill });
        }
      } catch {
        // Skip malformed domain dirs; the view stays best-effort.
      }
    }

    rows.sort((a, b) => b.skill.lastUsedAt - a.skill.lastUsedAt);
    return { rows, version: '1' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { rows: [], version: '1', errorMessage: msg };
  }
}
