/// <reference types="jest" />

import { serializeDOM } from '../../src/dom/dom-serializer';

function page() {
  return {
    evaluate: jest.fn().mockResolvedValue({
      url: 'https://example.com/noisy',
      title: 'Noisy fixture',
      scrollX: 0,
      scrollY: 0,
      scrollWidth: 1200,
      scrollHeight: 1600,
      viewportWidth: 1200,
      viewportHeight: 800,
    }),
  };
}

function cdp(root: Record<string, unknown>) {
  return {
    send: jest.fn().mockResolvedValue({ root }),
  };
}

function el(nodeId: number, tag: string, attrs: string[] = [], children: unknown[] = []) {
  return { nodeId, backendNodeId: nodeId + 100, nodeType: 1, nodeName: tag.toUpperCase(), localName: tag, attributes: attrs, children };
}

function txt(nodeId: number, value: string) {
  return { nodeId, backendNodeId: nodeId + 100, nodeType: 3, nodeName: '#text', localName: '', nodeValue: value };
}

const noisyDoc = {
  nodeId: 1, backendNodeId: 1, nodeType: 9, nodeName: '#document', localName: '',
  children: [el(2, 'html', [], [el(3, 'body', [], [
    ...Array.from({ length: 20 }, (_, i) => el(10 + i, 'img', ['src', `/ad-${i}.png`, 'class', 'decorative-ad-slot'])),
    el(40, 'a', ['href', '/promo'], [el(41, 'img', ['alt', 'Promo image', 'src', '/promo.png'])]),
    el(50, 'input', ['type', 'email', 'placeholder', 'Email', 'id', 'email-field']),
    el(51, 'button', ['id', 'save'], [txt(52, 'Save')]),
    el(60, 'iframe', ['src', '/frame.html', 'title', 'Frame'], []),
  ])])],
};

describe('DOM serializer planningProfile=stable', () => {
  test('omits decorative media while preserving actionable elements', async () => {
    const defaultResult = await serializeDOM(page() as never, cdp(noisyDoc) as never, {
      includePageStats: false,
      compression: 'none',
      planningProfile: 'default',
    });
    const stableResult = await serializeDOM(page() as never, cdp(noisyDoc) as never, {
      includePageStats: false,
      compression: 'none',
      planningProfile: 'stable',
    });

    expect(defaultResult.content).toContain('<img');
    expect(stableResult.content).not.toContain('decorative-ad-slot');
    expect(stableResult.content).toContain('<a href="/promo"');
    expect(stableResult.content).toContain('id="email-field"');
    expect(stableResult.content).toContain('<button id="save"');
    expect(stableResult.content).toContain('<iframe src="/frame.html"');
    expect(stableResult.content.length).toBeLessThan(defaultResult.content.length * 0.8);
  });

  test('emits stable planning metadata when page stats are included', async () => {
    const result = await serializeDOM(page() as never, cdp(noisyDoc) as never, {
      planningProfile: 'stable',
    });

    expect(result.content).toContain('[planning_profile] stable');
  });
});
