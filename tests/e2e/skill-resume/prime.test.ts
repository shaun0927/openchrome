import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SkillGraphStorage } from '../../../src/core/skill/storage';
import { decide } from '../../../src/pilot/skill/executor';
import {
  CART_FIXTURE_ACTIONS,
  CART_FIXTURE_STATES,
  primeSkillResumeGraph,
} from './prime';

describe('skill-resume graph priming utility', () => {
  it('writes a graph snapshot that the pilot executor can recommend from', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchrome-skill-resume-prime-'));
    const result = await primeSkillResumeGraph({
      rootDir,
      domain: 'fixture.local',
      initialState: CART_FIXTURE_STATES.cartPopulated,
      targetState: CART_FIXTURE_STATES.targetAdded,
    });

    expect(result.nodeCount).toBe(2);
    expect(result.edgeCount).toBe(1);
    expect(fs.existsSync(result.graphPath)).toBe(true);

    const storage = new SkillGraphStorage({ rootDir, domain: 'fixture.local' });
    const decision = decide({
      domain: 'fixture.local',
      currentStateHash: CART_FIXTURE_STATES.cartPopulated,
      candidateActions: [CART_FIXTURE_ACTIONS.addTargetItem],
    }, storage);

    expect(decision.kind).toBe('recommended');
    expect(decision.recommended).toEqual(CART_FIXTURE_ACTIONS.addTargetItem);
  });

  it('supports already-at-target decisions for the target cart state', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchrome-skill-resume-prime-target-'));
    await primeSkillResumeGraph({
      rootDir,
      domain: 'fixture.local',
      initialState: CART_FIXTURE_STATES.cartPopulated,
      targetState: CART_FIXTURE_STATES.targetAdded,
      steps: [{
        fromState: CART_FIXTURE_STATES.cartPopulated,
        action: CART_FIXTURE_ACTIONS.addTargetItem,
        toState: CART_FIXTURE_STATES.cartPopulated,
        successCount: 3,
      }],
    });

    const storage = new SkillGraphStorage({ rootDir, domain: 'fixture.local' });
    const decision = decide({
      domain: 'fixture.local',
      currentStateHash: CART_FIXTURE_STATES.cartPopulated,
      candidateActions: [CART_FIXTURE_ACTIONS.addTargetItem],
    }, storage);

    expect(decision.kind).toBe('already_at_target');
    expect(decision.skipUntil).toBe(CART_FIXTURE_STATES.cartPopulated);
  });
});
