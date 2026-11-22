import type {Point} from './geometry.ts';
import type {RenderPrimitive, RenderScene, SketchRenderer} from './renderer.ts';
import {referenceElement} from './reference.ts';
import {cssColor, rgba, snapColor} from './theme.ts';
import {pointsPath, ringsPath, svgElement} from './svg-dom.ts';
import type {SvgChild} from './svg-dom.ts';

let svgPatternSerial = 0;

function renderMarker(marker: Point, scene: RenderScene): SVGGElement {
  const ppu = Math.max(scene.viewport.pixelsPerWorldUnit, .01);
  const size = 7 / ppu;
  const [x, y] = marker;
  const group = svgElement('g', {'stroke-linecap': 'round'});
  for (const [width, color] of [[3.5 / ppu, '#ffffff'], [1.8 / ppu, cssColor(rgba(snapColor))]] as const) {
    group.append(
      svgElement('path', {d: `M${x - size} ${y}H${x + size}M${x} ${y - size}V${y + size}`,
        fill: 'none', stroke: color, 'stroke-width': width}),
      svgElement('circle', {cx: x, cy: y, r: size * .62, fill: 'none', stroke: color, 'stroke-width': width})
    );
  }
  return group;
}

function renderPrimitive(primitive: RenderPrimitive, scene: RenderScene): SvgChild | null {
  switch (primitive.kind) {
    case 'stroke': {
      if (primitive.points.length < 2) return null;
      return svgElement('path', {d: pointsPath(primitive.points, primitive.closed),
        fill: 'none', stroke: cssColor(primitive.color), 'stroke-width': primitive.width,
        'stroke-linecap': 'round', 'stroke-linejoin': 'round',
        'stroke-dasharray': primitive.dash ? primitive.dash.join(' ') : 'none'});
    }
    case 'ellipse':
      return svgElement('ellipse', {cx: primitive.center[0], cy: primitive.center[1],
        rx: Math.max(.1, primitive.radii[0]), ry: Math.max(.1, primitive.radii[1]),
        fill: primitive.fill ? cssColor(primitive.color) : 'none',
        'fill-opacity': primitive.fill ?? 0, stroke: cssColor(primitive.color),
        'stroke-width': primitive.width, 'stroke-dasharray': primitive.dash ? '9 5' : 'none'});
    case 'fill':
      return svgElement('path', {d: ringsPath(primitive.polygons.flat()), fill: cssColor(primitive.color),
        'fill-opacity': primitive.opacity, 'fill-rule': 'evenodd', stroke: 'none'});
    case 'marker':
      return renderMarker(primitive.marker.point, scene);
  }
}

/**
 * @entry 同一 RenderScene 的 SVG 实现：迁移期视觉对照与 SVG 回退几何。
 * 文字/标签由 board.drawOverlay 叠加；完整文档导出在 svg-document.ts。
 */
export class SvgRenderer implements SketchRenderer {
  readonly backend = 'svg' as const;
  private readonly geometry: SVGGElement;

  constructor(target: SVGSVGElement) {
    const existing = target.querySelector<SVGGElement>(':scope > [data-render-geometry]');
    this.geometry = existing ?? svgElement('g', {'data-render-geometry': '', 'pointer-events': 'none'});
    if (!existing) target.prepend(this.geometry);
  }

  resize(): void {}

  draw(scene: RenderScene): void {
    const gridId = `sim-sketch-render-grid-${++svgPatternSerial}`;
    const dots = svgElement('pattern', {id: gridId, width: scene.background.spacing,
      height: scene.background.spacing, patternUnits: 'userSpaceOnUse'},
      [svgElement('circle', {cx: scene.background.origin[0], cy: scene.background.origin[1],
        r: scene.background.radius, fill: cssColor(scene.background.dot)})]);
    const layers = scene.layers.map(layer => {
      const children: SvgChild[] = [];
      if (scene.reference?.layerId === layer.id) {
        const reference = referenceElement(scene.reference.source);
        if (reference) children.push(reference);
      }
      for (const primitive of [...layer.primitives, ...scene.temporary.filter(item => item.layerId === layer.id)]) {
        const node = renderPrimitive(primitive, scene);
        if (node) children.push(node);
      }
      return svgElement('g', {'data-layer-id': layer.id, opacity: layer.opacity ?? 1}, children);
    });
    const snaps = scene.snap.map(marker => renderMarker(marker.point, scene));
    this.geometry.replaceChildren(
      svgElement('defs', {}, [dots]),
      svgElement('rect', {x: -10000, y: -10000, width: 20000, height: 20000,
        fill: cssColor(scene.background.background)}),
      svgElement('rect', {x: -10000, y: -10000, width: 20000, height: 20000, fill: `url(#${gridId})`}),
      ...layers,
      ...snaps
    );
  }

  clearGeometry(): void {
    this.geometry.replaceChildren();
  }

  destroy(): void {
    this.geometry.remove();
  }
}
