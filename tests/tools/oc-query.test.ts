import { buildResponse, formatResponse, registerOcQueryTool } from '../../src/tools/oc-query';

describe('oc_query response helpers', () => {
  it('formats refs and parseable paths for interaction workflows', () => {
    const response = buildResponse('checkout button', 'interaction', [{
      path: 'results.0',
      ref: 'ref_1',
      source: 'dom',
      role: 'button',
      name: 'Checkout',
      score: 90,
      useWith: ['interact', 'act', 'fill_form'],
    }]);

    expect(response.nextAction).toContain('results.0.ref');
    expect(response.results[0].useWith).toContain('interact');
    expect(formatResponse(response)).toContain('results.0.ref=ref_1');
  });

  it('returns extraction-specific next tools', () => {
    const response = buildResponse('product card', 'extraction', []);

    expect(response.count).toBe(0);
    expect(response.nextAction).toContain('read_page');
  });
});

describe('registerOcQueryTool', () => {
  it('registers oc_query with annotations', () => {
    const registerTool = jest.fn();
    registerOcQueryTool({ registerTool } as any);

    expect(registerTool).toHaveBeenCalledWith(
      'oc_query',
      expect.any(Function),
      expect.objectContaining({
        name: 'oc_query',
        annotations: expect.objectContaining({ readOnlyHint: true }),
      }),
    );
  });
});
