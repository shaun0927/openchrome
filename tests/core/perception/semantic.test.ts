/// <reference types="jest" />
/**
 * Unit tests for the rule-based Semantic perception view (issue #850).
 *
 * The tests build synthetic AX trees + DOM snapshots so we can exercise
 * each region kind classifier and the structural rules (nesting,
 * list-collapse) without spinning up a browser.
 */

import {
  buildSemanticView,
  type SemanticAXNode,
  type SemanticDomElement,
  type SemanticDomSnapshot,
  type SemanticRuleSet,
} from '../../../src/core/perception/semantic';
import rulesJson from '../../../src/core/perception/semantic-rules.json';

const RULES = rulesJson as SemanticRuleSet;

interface BuildArgs {
  axNodes: SemanticAXNode[];
  domElements?: SemanticDomElement[];
  refStart?: number;
}

function build({ axNodes, domElements, refStart = 0 }: BuildArgs) {
  let counter = refStart;
  const allocateRef = (n: SemanticAXNode): string | undefined => {
    if (n.backendDOMNodeId === undefined) return undefined;
    counter++;
    return `ref_${counter}`;
  };
  const domSnapshot: SemanticDomSnapshot | undefined = domElements
    ? { elements: domElements }
    : undefined;
  return buildSemanticView(
    {
      url: 'file:///fixture.html',
      title: 'Fixture',
      axNodes,
      domSnapshot,
      allocateRef,
    },
    RULES
  );
}

describe('buildSemanticView — empty AX tree (P5 hint)', () => {
  test('returns empty regions and tree_empty flag', () => {
    const view = build({ axNodes: [] });
    expect(view.regions).toEqual([]);
    expect(view.refs).toEqual({});
    expect(view.aria?.tree_empty).toBe(true);
  });
});

describe('buildSemanticView — product kind classifier', () => {
  test('classifies a Product microdata article as kind=product with price + add-to-cart action', () => {
    const axNodes: SemanticAXNode[] = [
      { nodeId: 1, role: 'main', childIds: [2] },
      { nodeId: 2, backendDOMNodeId: 10, role: 'article', name: 'Premium Wireless Headphones', childIds: [3, 4, 5, 6] },
      { nodeId: 3, backendDOMNodeId: 11, role: 'heading', name: 'Premium Wireless Headphones', childIds: [] },
      { nodeId: 4, backendDOMNodeId: 12, role: 'StaticText', name: 'Studio-grade noise cancelling headphones.', childIds: [] },
      { nodeId: 5, backendDOMNodeId: 13, role: 'StaticText', name: '$99.99', childIds: [] },
      { nodeId: 6, backendDOMNodeId: 14, role: 'button', name: 'Add to Cart', childIds: [] },
    ];
    const domElements: SemanticDomElement[] = [
      { backendDOMNodeId: 10, tagName: 'article', itemType: 'https://schema.org/Product' },
      { backendDOMNodeId: 11, tagName: 'h1', itemProp: 'name', text: 'Premium Wireless Headphones' },
      { backendDOMNodeId: 12, tagName: 'p', itemProp: 'description', text: 'Studio-grade noise cancelling headphones.' },
      { backendDOMNodeId: 13, tagName: 'div', itemProp: 'price', classNames: 'price', attrs: { 'data-price': '99.99' }, text: '$99.99' },
      { backendDOMNodeId: 14, tagName: 'button', text: 'Add to Cart' },
    ];
    const view = build({ axNodes, domElements });

    expect(view.regions.length).toBeGreaterThan(0);
    const product = view.regions.find((r) => r.kind === 'product');
    expect(product).toBeDefined();
    expect(product!.state.name).toBe('Premium Wireless Headphones');
    expect(product!.state.price).toBe('99.99');
    // Label template references `{title}`; itemprop="name" must alias
    // to `state.title` so the rendered label includes the product name
    // rather than rendering as bare "Product:".
    expect(product!.state.title).toBe('Premium Wireless Headphones');
    expect(product!.label).toMatch(/Product: Premium Wireless Headphones/);

    const addToCart = product!.actions.find((a) => /add to cart/i.test(a.target));
    expect(addToCart).toBeDefined();
    expect(addToCart!.verb).toBe('click');
    expect(view.refs[addToCart!.ref_id]).toBeDefined();
  });
});

describe('buildSemanticView — form kind classifier', () => {
  test('classifies a multi-field <form> as kind=form with fill/submit actions', () => {
    const axNodes: SemanticAXNode[] = [
      { nodeId: 1, role: 'main', childIds: [2] },
      { nodeId: 2, backendDOMNodeId: 20, role: 'form', name: 'Create your account', childIds: [3, 4, 5, 6] },
      { nodeId: 3, backendDOMNodeId: 21, role: 'textbox', name: 'Email address', childIds: [] },
      { nodeId: 4, backendDOMNodeId: 22, role: 'textbox', name: 'Username', childIds: [] },
      { nodeId: 5, backendDOMNodeId: 23, role: 'textbox', name: 'Password', childIds: [] },
      { nodeId: 6, backendDOMNodeId: 24, role: 'button', name: 'Create account', childIds: [] },
    ];
    const domElements: SemanticDomElement[] = [
      { backendDOMNodeId: 20, tagName: 'form' },
    ];
    const view = build({ axNodes, domElements });
    const form = view.regions.find((r) => r.kind === 'form');
    expect(form).toBeDefined();
    expect(form!.actions.filter((a) => a.verb === 'fill').length).toBeGreaterThanOrEqual(3);
    expect(form!.actions.some((a) => /create account/i.test(a.target))).toBe(true);
  });
});

describe('buildSemanticView — navigation kind classifier', () => {
  test('classifies a <nav> region with link actions', () => {
    const axNodes: SemanticAXNode[] = [
      { nodeId: 1, role: 'navigation', name: 'Main menu', childIds: [2, 3] },
      { nodeId: 2, backendDOMNodeId: 100, role: 'link', name: 'Home', href: '/home', childIds: [] },
      { nodeId: 3, backendDOMNodeId: 101, role: 'link', name: 'About', href: '/about', childIds: [] },
    ];
    const view = build({ axNodes });
    const nav = view.regions.find((r) => r.kind === 'navigation');
    expect(nav).toBeDefined();
    // Links with hrefs map to verb='navigate'.
    expect(nav!.actions.every((a) => a.verb === 'navigate')).toBe(true);
  });
});

describe('buildSemanticView — article kind classifier', () => {
  test('classifies an article role with heading + summary state', () => {
    const axNodes: SemanticAXNode[] = [
      { nodeId: 1, role: 'main', childIds: [2] },
      { nodeId: 2, backendDOMNodeId: 30, role: 'article', name: 'City Approves Transit Plan', childIds: [3, 4] },
      { nodeId: 3, backendDOMNodeId: 31, role: 'heading', name: 'City Approves Transit Plan', childIds: [] },
      { nodeId: 4, backendDOMNodeId: 32, role: 'StaticText', name: 'The council voted seven to two.', childIds: [] },
    ];
    const view = build({ axNodes });
    const article = view.regions.find((r) => r.kind === 'article');
    expect(article).toBeDefined();
    expect(article!.state.heading).toBe('City Approves Transit Plan');
    expect(article!.state.summary?.length).toBeGreaterThan(0);
  });
});

describe('buildSemanticView — media kind classifier', () => {
  test('classifies a <figure> region as kind=media', () => {
    const axNodes: SemanticAXNode[] = [
      { nodeId: 1, role: 'main', childIds: [2] },
      { nodeId: 2, backendDOMNodeId: 40, role: 'group', name: 'Hero image', childIds: [3] },
      { nodeId: 3, backendDOMNodeId: 41, role: 'img', name: 'Hero', childIds: [] },
    ];
    const domElements: SemanticDomElement[] = [
      { backendDOMNodeId: 40, tagName: 'figure' },
      { backendDOMNodeId: 41, tagName: 'img' },
    ];
    const view = build({ axNodes, domElements });
    const media = view.regions.find((r) => r.kind === 'media');
    expect(media).toBeDefined();
  });
});

describe('buildSemanticView — generic region with no actions is dropped', () => {
  test('promotes only candidates with descendants of interest', () => {
    const axNodes: SemanticAXNode[] = [
      { nodeId: 1, role: 'main', childIds: [2] },
      // Section with nothing interactive inside it.
      { nodeId: 2, role: 'region', name: 'Empty section', childIds: [3] },
      { nodeId: 3, role: 'StaticText', name: 'Just words.', childIds: [] },
    ];
    const view = build({ axNodes });
    expect(view.regions.every((r) => r.kind !== 'generic')).toBe(true);
  });
});

describe('buildSemanticView — list collapse rule', () => {
  test('collapses ≥ threshold sibling regions with identical role digest', () => {
    // 6 listitem regions, each containing a single link.
    const axNodes: SemanticAXNode[] = [
      { nodeId: 1, role: 'main', childIds: [2, 3, 4, 5, 6, 7] },
    ];
    for (let i = 0; i < 6; i++) {
      const liId = 2 + i;
      const linkId = 100 + i;
      axNodes.push({
        nodeId: liId,
        role: 'listitem',
        name: `Item ${i + 1}`,
        childIds: [linkId],
      });
      axNodes.push({
        nodeId: linkId,
        backendDOMNodeId: 500 + i,
        role: 'link',
        name: `Result ${i + 1}`,
        href: `/p/${i + 1}`,
        childIds: [],
      });
    }
    const view = build({ axNodes });
    const lists = view.regions.filter((r) => r.kind === 'list');
    expect(lists.length).toBe(1);
    expect(lists[0].state.item_count).toBe('6');
    expect(lists[0].state.sample).toBeDefined();
  });

  test('keeps regions individually when below threshold', () => {
    const axNodes: SemanticAXNode[] = [
      { nodeId: 1, role: 'main', childIds: [2, 3] },
      { nodeId: 2, role: 'listitem', name: 'A', childIds: [4] },
      { nodeId: 3, role: 'listitem', name: 'B', childIds: [5] },
      { nodeId: 4, backendDOMNodeId: 200, role: 'link', name: 'Link A', href: '/a', childIds: [] },
      { nodeId: 5, backendDOMNodeId: 201, role: 'link', name: 'Link B', href: '/b', childIds: [] },
    ];
    const view = build({ axNodes });
    expect(view.regions.filter((r) => r.kind === 'list').length).toBe(0);
  });
});

describe('buildSemanticView — nesting rule', () => {
  test('outer region is dropped when fully covered by an inner region', () => {
    // <main><article role=region><form>...</form></article></main>
    // 'region' role on outer has no own content beyond the inner form.
    const axNodes: SemanticAXNode[] = [
      { nodeId: 1, role: 'main', childIds: [2] },
      { nodeId: 2, role: 'region', name: 'Outer', childIds: [3] },
      { nodeId: 3, backendDOMNodeId: 50, role: 'form', name: 'Inner form', childIds: [4, 5] },
      { nodeId: 4, backendDOMNodeId: 51, role: 'textbox', name: 'Field A', childIds: [] },
      { nodeId: 5, backendDOMNodeId: 52, role: 'textbox', name: 'Field B', childIds: [] },
    ];
    const view = build({ axNodes });
    // Inner form must be present, outer region must NOT be present
    // (since every AX descendant of outer is covered by the inner form).
    const kinds = view.regions.map((r) => r.kind);
    expect(kinds).toContain('form');
    expect(kinds).not.toContain('generic');
  });

  test('outer region is kept when it has AX content outside the inner', () => {
    const axNodes: SemanticAXNode[] = [
      { nodeId: 1, role: 'main', childIds: [2] },
      { nodeId: 2, backendDOMNodeId: 60, role: 'article', name: 'Page', childIds: [3, 6] },
      // outer content
      { nodeId: 3, backendDOMNodeId: 61, role: 'heading', name: 'Header', childIds: [] },
      // nested inner form
      { nodeId: 6, backendDOMNodeId: 62, role: 'form', name: 'Inner', childIds: [7, 8] },
      { nodeId: 7, backendDOMNodeId: 63, role: 'textbox', name: 'A', childIds: [] },
      { nodeId: 8, backendDOMNodeId: 64, role: 'textbox', name: 'B', childIds: [] },
    ];
    const view = build({ axNodes });
    expect(view.regions.some((r) => r.kind === 'article')).toBe(true);
    expect(view.regions.some((r) => r.kind === 'form')).toBe(true);
  });
});

describe('buildSemanticView — determinism', () => {
  test('produces byte-identical output across 100 runs (refs normalized)', () => {
    const buildOnce = () => {
      const axNodes: SemanticAXNode[] = [
        { nodeId: 1, role: 'main', childIds: [2] },
        { nodeId: 2, backendDOMNodeId: 10, role: 'article', name: 'P', childIds: [3, 4] },
        { nodeId: 3, backendDOMNodeId: 11, role: 'heading', name: 'P', childIds: [] },
        { nodeId: 4, backendDOMNodeId: 12, role: 'button', name: 'Buy', childIds: [] },
      ];
      const view = build({ axNodes });
      return JSON.stringify(view);
    };
    const baseline = buildOnce();
    for (let i = 0; i < 100; i++) {
      expect(buildOnce()).toBe(baseline);
    }
  });
});

describe('buildSemanticView — ref interop contract (#831)', () => {
  test('every action ref_id has a matching entry in view.refs with backendDOMNodeId', () => {
    const axNodes: SemanticAXNode[] = [
      { nodeId: 1, role: 'main', childIds: [2] },
      { nodeId: 2, backendDOMNodeId: 80, role: 'form', name: 'F', childIds: [3, 4] },
      { nodeId: 3, backendDOMNodeId: 81, role: 'textbox', name: 'E', childIds: [] },
      { nodeId: 4, backendDOMNodeId: 82, role: 'button', name: 'Go', childIds: [] },
    ];
    const view = build({ axNodes });
    for (const region of view.regions) {
      for (const action of region.actions) {
        const ref = view.refs[action.ref_id];
        expect(ref).toBeDefined();
        expect(ref.backendDOMNodeId).toBeGreaterThan(0);
      }
    }
  });
});
