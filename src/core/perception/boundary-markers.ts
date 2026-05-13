/** Page-origin boundary marker helpers (#833). */

export function areBoundaryMarkersEnabled(args?: Record<string, unknown>): boolean {
  if (process.env.OPENCHROME_BOUNDARY_MARKERS === '0') return false;
  return args?.boundaryMarkers !== false;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

export function escapeBoundaryContent(text: string, markerName: string): string {
  return text
    .replace(new RegExp(`<(/oc:${markerName})`, 'g'), '<\u200B$1')
    .replace(new RegExp(`<(oc:${markerName})(?=[\\s>])`, 'g'), '<\u200B$1');
}

export function wrapBoundaryMarker(markerName: string, attrs: Record<string, string | undefined>, body: string): string {
  const attrText = Object.entries(attrs)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([key, value]) => ` ${key}="${escapeAttr(value)}"`)
    .join('');
  return `<oc:${markerName}${attrText}>${escapeBoundaryContent(body, markerName)}</oc:${markerName}>`;
}
