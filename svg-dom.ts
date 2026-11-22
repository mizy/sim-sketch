import type {Point} from './geometry.ts';

export const svgNamespace = 'http://www.w3.org/2000/svg';

export type SvgChild = Node | string;

export function svgElement<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attributes: Record<string, string | number> = {},
  children: SvgChild[] = []
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(svgNamespace, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  node.append(...children);
  return node;
}

const round = (value: number): number => Math.round(value * 1000) / 1000;

/** 世界坐标折线转 SVG path。闭合环由 renderer 决定是否补 Z。 */
export function pointsPath(points: readonly Point[], closed = false): string {
  if (!points.length) return '';
  const [first, ...rest] = points;
  return `M${round(first[0])} ${round(first[1])}` +
    rest.map(([x, y]) => `L${round(x)} ${round(y)}`).join('') + (closed ? 'Z' : '');
}

export function ringsPath(rings: readonly (readonly Point[])[]): string {
  return rings.map(ring => pointsPath(ring, true)).join('');
}
