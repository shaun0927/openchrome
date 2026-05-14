export interface ElementPickerBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ElementPickerViewport {
  width: number;
  height: number;
}

export interface ElementPickerAncestryNode {
  tagName: string;
  id?: string | null;
  classes?: string[];
  attributes?: Record<string, string | undefined>;
  nthOfType: number;
}

export interface PickedElementSelectors {
  role?: string;
  accessibleName?: string;
  text?: string;
  cssPath: string;
  xPath: string;
  nthOfType: string;
}

export interface PickedElement {
  nodeRef: string | null;
  backendNodeId: number | null;
  loaderId: string | null;
  selectors: PickedElementSelectors;
  boundingBox: ElementPickerBoundingBox;
  screenshotPng?: string;
  computedStyle: Record<string, string>;
  domSnippet: string;
  pickedAt: number;
  pageUrl: string;
  pageTitle: string;
}

export interface ElementPickRecorderInput {
  ancestry: ElementPickerAncestryNode[];
  role?: string;
  accessibleName?: string;
  text?: string;
  boundingBox: ElementPickerBoundingBox;
  viewport: ElementPickerViewport;
  domSnippet: string;
  computedStyle?: Record<string, string>;
  screenshotPng?: string;
  nodeRef?: string | null;
  backendNodeId?: number | null;
  loaderId?: string | null;
  pageUrl: string;
  pageTitle: string;
  pickedAt?: number;
}
