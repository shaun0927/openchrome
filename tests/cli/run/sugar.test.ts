import { RUN_SUGAR_COMMANDS, resolveSugarArgs } from '../../../cli/run-sugar';

describe('oc run sugar commands (#843)', () => {
  test('includes common positional wrappers', () => {
    expect(RUN_SUGAR_COMMANDS.map((s) => s.tool)).toEqual(expect.arrayContaining([
      'navigate',
      'tabs_create',
      'read_page',
      'page_screenshot',
      'tabs_context',
      'tabs_close',
      'wait_for',
      'click',
      'interact',
      'form_input',
      'javascript_tool',
      'oc_assert',
    ]));
  });

  test('maps navigate URL to named arg', () => {
    const spec = RUN_SUGAR_COMMANDS.find((s) => s.tool === 'navigate')!;
    expect(resolveSugarArgs(spec, ['https://example.com'])).toEqual({ url: 'https://example.com' });
  });

  test('parses oc_assert contract JSON when possible', () => {
    const spec = RUN_SUGAR_COMMANDS.find((s) => s.tool === 'oc_assert')!;
    expect(resolveSugarArgs(spec, ['{"type":"text"}'])).toEqual({ contract: { type: 'text' } });
  });
});
