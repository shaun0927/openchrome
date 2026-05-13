/// <reference types="jest" />

import { areBoundaryMarkersEnabled, wrapBoundaryMarker } from '../../../src/core/perception/boundary-markers';

describe('boundary markers', () => {
  afterEach(() => { delete process.env.OPENCHROME_BOUNDARY_MARKERS; });

  test('wraps and escapes page-origin close/open tokens', () => {
    const wrapped = wrapBoundaryMarker('page', { src: 'https://example.test/?q="x"', mode: 'dom' }, 'x </oc:page> y <oc:page z');
    expect(wrapped).toContain('<oc:page src="https://example.test/?q=&quot;x&quot;" mode="dom">');
    expect(wrapped).toContain('<\u200B/oc:page>');
    expect(wrapped).toContain('<\u200Boc:page');
    expect(wrapped.endsWith('</oc:page>')).toBe(true);
  });

  test('honors env and per-call opt out', () => {
    expect(areBoundaryMarkersEnabled({})).toBe(true);
    expect(areBoundaryMarkersEnabled({ boundaryMarkers: false })).toBe(false);
    process.env.OPENCHROME_BOUNDARY_MARKERS = '0';
    expect(areBoundaryMarkersEnabled({})).toBe(false);
  });
});
