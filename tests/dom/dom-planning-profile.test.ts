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


  test('keeps meaningful media descendants and control-enabled media in stable output', async () => {
    const doc = {
      nodeId: 1, backendNodeId: 1, nodeType: 9, nodeName: '#document', localName: '',
      children: [el(2, 'html', [], [el(3, 'body', [], [
        el(10, 'a', ['href', '/hero'], [
          el(11, 'picture', [], [
            el(12, 'source', ['src', '/hero.webp']),
            el(13, 'img', ['src', '/hero.png', 'alt', 'Hero product']),
          ]),
        ]),
        el(20, 'video', ['src', '/demo.mp4', 'controls', ''], []),
      ])])],
    };

    const result = await serializeDOM(page() as never, cdp(doc) as never, {
      includePageStats: false,
      compression: 'none',
      planningProfile: 'stable',
    });

    expect(result.content).toContain('<a href="/hero"');
    expect(result.content).toContain('<img src="/hero.png" alt="Hero product"');
    expect(result.content).toContain('<video src="/demo.mp4" controls=""');
  });

  test('preserves volatile ids referenced by labels in stable output', async () => {
    const doc = {
      nodeId: 1, backendNodeId: 1, nodeType: 9, nodeName: '#document', localName: '',
      children: [el(2, 'html', [], [el(3, 'body', [], [
        el(10, 'label', ['for', 'field-123456789abc'], [txt(11, 'Email')]),
        el(12, 'input', ['id', 'field-123456789abc', 'type', 'email']),
        el(13, 'input', ['id', 'generated-abcdef1234567890', 'type', 'text']),
      ])])],
    };

    const result = await serializeDOM(page() as never, cdp(doc) as never, {
      includePageStats: false,
      compression: 'none',
      planningProfile: 'stable',
    });

    expect(result.content).toContain('for="field-123456789abc"');
    expect(result.content).toContain('id="field-123456789abc"');
    expect(result.content).not.toContain('id="generated-abcdef1234567890"');
  });

  test('suppresses decorative media group summaries in stable output', async () => {
    const doc = {
      nodeId: 1, backendNodeId: 1, nodeType: 9, nodeName: '#document', localName: '',
      children: [el(2, 'html', [], [el(3, 'body', [], [
        ...Array.from({ length: 5 }, (_, i) => el(10 + i, 'img', ['src', `/noise-${i}.png`])),
      ])])],
    };

    const result = await serializeDOM(page() as never, cdp(doc) as never, {
      includePageStats: false,
      compression: 'light',
      planningProfile: 'stable',
    });

    expect(result.content).not.toContain('img ×5');
    expect(result.content).not.toContain('<img');
  });

  test('emits stable planning metadata when page stats are included', async () => {
    const result = await serializeDOM(page() as never, cdp(noisyDoc) as never, {
      planningProfile: 'stable',
    });

    expect(result.content).toContain('[planning_profile] stable');
  });

  test('preserves volatile IDs referenced by ARIA IDREF attrs in stable output', async () => {
    const doc = {
      nodeId: 1, backendNodeId: 1, nodeType: 9, nodeName: '#document', localName: '',
      children: [el(2, 'html', [], [el(3, 'body', [], [
        // combobox with aria-activedescendant pointing to a react-aria volatile id
        el(10, 'div', ['role', 'combobox', 'aria-activedescendant', 'react-aria-abc123def456'], []),
        el(11, 'div', ['id', 'react-aria-abc123def456', 'role', 'option'], [txt(12, 'Option A')]),
        // unreferenced generated id should be stripped
        el(13, 'div', ['id', 'react-aria-xyz999888777'], [txt(14, 'Noise')]),
      ])])],
    };

    const result = await serializeDOM(page() as never, cdp(doc) as never, {
      includePageStats: false,
      compression: 'none',
      planningProfile: 'stable',
    });

    // referenced id must survive volatile-id pruning
    expect(result.content).toContain('id="react-aria-abc123def456"');
    // unreferenced generated id must be stripped
    expect(result.content).not.toContain('id="react-aria-xyz999888777"');
    // default mode must strip nothing
    const defaultResult = await serializeDOM(page() as never, cdp(doc) as never, {
      includePageStats: false,
      compression: 'none',
      planningProfile: 'default',
    });
    expect(defaultResult.content).toContain('id="react-aria-abc123def456"');
    expect(defaultResult.content).toContain('id="react-aria-xyz999888777"');
  });
});
