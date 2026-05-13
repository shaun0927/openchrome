import type { EpisodeAdapter, EpisodeAdapterInput, EpisodeToolCall } from './types';

const TASK_PLANS: Record<string, EpisodeToolCall[]> = {
  'example-h1': [
    { tool: 'read_page', args: {} },
  ],
  'local-form-submit': [
    { tool: 'read_page', args: {} },
    { tool: 'form_input', args: { selector: '#name', value: 'OpenChrome' } },
    { tool: 'form_input', args: { selector: '#email', value: 'test@example.invalid' } },
    { tool: 'click', args: { selector: 'button[type=submit]' } },
  ],
  'local-recovery-stall': [
    { tool: 'read_page', args: {} },
    { tool: 'read_page', args: {} },
    { tool: 'read_page', args: {} },
    { tool: 'read_page', args: {} },
  ],
};

export class MockEpisodeAdapter implements EpisodeAdapter {
  name = 'mock';

  async next(input: EpisodeAdapterInput): Promise<EpisodeToolCall | { done: true }> {
    const plan = TASK_PLANS[input.task.id] ?? [];
    return plan[input.step] ?? { done: true };
  }
}
