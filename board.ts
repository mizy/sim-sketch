import {markGeometry} from './annotations.ts';
import {defaultLayerId, markColor} from './project.ts';
import type {Mark, Project} from './project.ts';
import {shapeClosed, shapePath, sketchInk} from './geometry.ts';
import type {Point, Shape} from './geometry.ts';
import {referenceElement} from './reference.ts';
import {gridSpec} from './scene.ts';
import {cssColor} from './theme.ts';
import {svgElement} from './svg-dom.ts';
import type {SvgChild} from './svg-dom.ts';


export interface BoardView {
  temporaryMark?: Mark | null;
  temporaryShape?: Shape | null;
  selectedMark?: string | null;
  selectedShapes?: readonly string[];
}

export interface OverlayView {
  selectedMark?: string | null;
  selectedShapes?: readonly string[];
  /** 导出时没有交互，不需要透明命中代理。 */
  hitProxies?: boolean;
}

let patternSerial = 0;

export function boardPoint(board: SVGSVGElement, event: {clientX: number; clientY: number}): Point {
  const matrix = board.getScreenCTM();
  if (!matrix) return [Math.round(event.clientX), Math.round(event.clientY)];
  const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
  return [Math.round(point.x), Math.round(point.y)];
}

function pointText(points: readonly Point[]): string {
  return points.map(point => point.join(',')).join(' ');
}

function hitPath(d: string, closed: boolean): SVGPathElement {
  return svgElement('path', {d, fill: closed ? 'transparent' : 'none', 'fill-rule': 'evenodd',
    stroke: 'transparent', 'stroke-width': 18, 'pointer-events': 'all'});
}

function annotation(mark: Mark, selected: boolean, overlayOnly: boolean): SVGGElement {
  const group = svgElement('g', {'data-id': mark.id, 'stroke-linecap': 'round', 'stroke-linejoin': 'round'});
  let anchor: Point | undefined;
  switch (mark.shape) {
    case 'pen': {
      const style = markGeometry(mark, selected);
      anchor = style.points[0];
      const trace = style.points.length === 1 ? [anchor, [anchor[0] + .1, anchor[1]] as Point] : style.points;
      const points = pointText(trace);
      group.append(svgElement('polyline', {points, fill: 'none', stroke: 'transparent', 'stroke-width': 18,
        'pointer-events': overlayOnly ? 'stroke' : 'none'}));
      if (!overlayOnly) group.append(svgElement('polyline', {points, fill: 'none', stroke: style.color, 'stroke-width': style.width}));
      break;
    }
    case 'region': {
      const style = markGeometry(mark, selected);
      const {a, b} = mark;
      anchor = [Math.min(a[0], b[0]), Math.min(a[1], b[1])];
      const [cx, cy] = style.center;
      const [rx, ry] = style.radii;
      if (overlayOnly) {
        group.append(svgElement('ellipse', {cx, cy, rx, ry, fill: 'transparent', stroke: 'transparent',
          'stroke-width': 18, 'pointer-events': 'all'}));
      } else {
        group.append(svgElement('ellipse', {cx, cy, rx, ry, fill: style.color,
          'fill-opacity': style.fill, stroke: style.color, 'stroke-width': style.width,
          'stroke-dasharray': style.dashed ? '9 5' : 'none'}));
      }
      break;
    }
    case 'arrow': {
      const style = markGeometry(mark, selected);
      const [a, b, left, , right] = style.points;
      anchor = a;
      const d = `M${a} L${b} M${left} L${b} L${right}`;
      group.append(svgElement('path', {d, fill: 'none', stroke: 'transparent', 'stroke-width': 22,
        'pointer-events': overlayOnly ? 'stroke' : 'none'}));
      if (!overlayOnly) group.append(svgElement('path', {d, fill: 'none', stroke: style.color, 'stroke-width': style.width}));
      break;
    }
    case 'text':
      anchor = mark.a;
      break;
  }
  const value = mark.value === null ? '' : ` ${mark.value} ${mark.unit}`;
  const label = (mark.label + value).trim();
  if (label && anchor && mark.shape === 'text') {
    const style = markGeometry(mark, selected);
    const width = Array.from(label).reduce((sum, char) => sum + ((char.codePointAt(0) ?? 0) > 255 ? 22 : 13), 0);
    group.append(svgElement('rect', {x: anchor[0] - 3, y: anchor[1] - 3, width: width + 6, height: 29,
      rx: 3, fill: 'transparent', stroke: selected ? '#3047cc' : 'none', 'stroke-width': 1.5, 'stroke-dasharray': '4 3'}));
    group.append(svgElement('text', {x: anchor[0], y: anchor[1], fill: style.color, 'font-size': 22,
      'font-family': 'system-ui, sans-serif', 'font-weight': 650, 'dominant-baseline': 'hanging',
      'paint-order': 'stroke', stroke: selected ? '#ffffff' : 'none', 'stroke-width': 3}, [label]));
  } else if (label && anchor) {
    const color = markColor(mark);
    const characters = Array.from(label);
    const visibleLabel = characters.length > 29 ? characters.slice(0, 28).join('') + '…' : label;
    const width = Math.min(665, Array.from(visibleLabel).reduce((total, char) =>
      total + ((char.codePointAt(0) ?? 0) > 255 ? 24 : 13), 22));
    const x = Math.max(4, Math.min(956 - width, anchor[0] + (mark.shape === 'arrow' ? 10 : 0)));
    const y = anchor[1] - 9;
    group.append(svgElement('rect', {x, y: y - 25, width, height: 34, rx: 7,
      fill: '#ffffff', stroke: color, 'stroke-width': selected ? 2 : 1}));
    group.append(svgElement('text', {x: x + 9, y, fill: color, 'font-size': 22,
      'font-family': 'system-ui, sans-serif', 'font-weight': 650}, [visibleLabel]));
  }
  return group;
}

function sketchShape(shape: Shape, selected: boolean, overlayOnly: boolean): SVGGElement {
  const group = svgElement('g', {'data-shape-id': shape.id});
  const d = shapePath(shape);
  if (!d) return group;
  if (overlayOnly) {
    group.append(hitPath(d, shapeClosed(shape)));
    return group;
  }
  const closed = shapeClosed(shape);
  const color = shape.color ?? sketchInk;
  const strokeWidth = shape.strokeWidth ?? 2.4;
  if (selected) {
    group.append(svgElement('path', {d, fill: 'none', stroke: '#3047cc', 'stroke-width': strokeWidth + 7,
      'stroke-opacity': .16, 'stroke-linecap': 'round', 'stroke-linejoin': 'round'}));
  }
  group.append(svgElement('path', {d, fill: closed ? color : 'none', 'fill-opacity': closed ? .12 : 0,
    'fill-rule': 'evenodd', stroke: selected ? '#3047cc' : color, 'stroke-width': selected ? strokeWidth + .8 : strokeWidth,
    'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'pointer-events': 'all'}));
  group.append(svgElement('path', {d, fill: closed ? '#000' : 'none', 'fill-opacity': 0, stroke: '#000',
    'stroke-opacity': 0, 'stroke-width': 16, 'pointer-events': 'all'}));
  return group;
}

function layerGroup(layerId: string, opacity: number, children: SvgChild[]): SVGGElement {
  return svgElement('g', {'data-layer-id': layerId, opacity: opacity ?? 1}, children);
}

/** 只移动/删除顺序不一致的节点；图元顺序稳定时一次 pointermove 不触发 DOM 重排。 */
function syncChildren(parent: Element, desired: readonly Node[]): void {
  desired.forEach((node, index) => {
    const current = parent.childNodes[index];
    if (current !== node) parent.insertBefore(node, current ?? null);
  });
  while (parent.childNodes.length > desired.length) parent.lastChild?.remove();
}

function overlayLayer(root: SVGGElement, layerId: string, opacity: number): SVGGElement {
  for (const child of root.children) {
    if (child instanceof SVGGElement && child.dataset.layerId === layerId) {
      child.setAttribute('opacity', String(opacity));
      return child;
    }
  }
  const group = svgElement('g', {'data-layer-id': layerId, opacity});
  group.append(svgElement('g', {'data-hit-proxies': ''}), svgElement('g', {'data-mark-overlay': ''}));
  root.append(group);
  return group;
}

function hitShapes(group: SVGGElement): SVGGElement {
  let hits = group.querySelector<SVGGElement>(':scope > [data-hit-proxies]');
  if (!hits) {
    hits = svgElement('g', {'data-hit-proxies': ''});
    group.prepend(hits);
  }
  return hits;
}

function markOverlay(group: SVGGElement): SVGGElement {
  let marks = group.querySelector<SVGGElement>(':scope > [data-mark-overlay]');
  if (!marks) {
    marks = svgElement('g', {'data-mark-overlay': ''});
    group.append(marks);
  }
  return marks;
}

const hitShapeSources = new WeakMap<SVGGElement, Shape>();
const markNodeSources = new WeakMap<SVGGElement, {mark: Mark; selected: boolean}>();

function updateShapeHit(node: SVGGElement, shape: Shape): void {
  // 未变化的图元保持同一 shape 引用；只有被拖动/编辑的图元才重写 path。
  if (hitShapeSources.get(node) === shape) return;
  hitShapeSources.set(node, shape);
  const path = node.firstElementChild as SVGPathElement | null;
  const d = shapePath(shape);
  if (!d) {
    path?.remove();
    return;
  }
  if (!path) {
    node.append(hitPath(d, shapeClosed(shape)));
    return;
  }
  path.setAttribute('d', d);
  path.setAttribute('fill', shapeClosed(shape) ? 'transparent' : 'none');
  path.setAttribute('fill-rule', 'evenodd');
}

/**
 * @entry 文字/标签与交互命中层。GPU/Canvas2D 模式下只画这一层；SVG 模式叠加在几何之上。
 * 命中代理按 shape id 增量复用，避免 2000 图元时每个 pointermove 重建整层 DOM。
 */
export function drawOverlay(board: SVGSVGElement, project: Project, view: OverlayView = {}): void {
  const {selectedMark = null, selectedShapes = [], hitProxies = true} = view;
  const root = board.querySelector<SVGGElement>(':scope > [data-overlay]') ??
    svgElement('g', {'data-overlay': ''});
  if (!root.parentNode) board.append(root);
  const layers = project.layers.length ? project.layers : [{id: defaultLayerId, name: '图层 1', opacity: 1}];
  const desiredLayers: SVGGElement[] = [];

  for (const layer of layers) {
    const group = overlayLayer(root, layer.id, layer.opacity ?? 1);
    const hits = hitShapes(group);
    const existing = new Map<string, SVGGElement>();
    for (const child of hits.children) {
      if (child instanceof SVGGElement && child.dataset.shapeId) existing.set(child.dataset.shapeId, child);
    }
    const desiredShapes: SVGGElement[] = [];
    for (const shape of project.shapes ?? []) {
      if ((shape.layerId ?? defaultLayerId) !== layer.id) continue;
      if (!hitProxies) continue;
      const node = existing.get(shape.id) ?? sketchShape(shape, selectedShapes.includes(shape.id), true);
      existing.delete(shape.id);
      updateShapeHit(node, shape);
      desiredShapes.push(node);
    }
    syncChildren(hits, desiredShapes);
    const marks = markOverlay(group);
    const existingMarks = new Map<string, SVGGElement>();
    for (const child of marks.children) {
      if (child instanceof SVGGElement && child.dataset.id) existingMarks.set(child.dataset.id, child);
    }
    const desiredMarks: SVGGElement[] = [];
    for (const mark of project.marks) {
      if ((mark.layerId ?? defaultLayerId) !== layer.id) continue;
      const selected = mark.id === selectedMark;
      const cached = existingMarks.get(mark.id);
      const source = cached ? markNodeSources.get(cached) : undefined;
      existingMarks.delete(mark.id);
      if (cached && source?.mark === mark && source.selected === selected) {
        desiredMarks.push(cached);
        continue;
      }
      const node = annotation(mark, selected, true);
      markNodeSources.set(node, {mark, selected});
      desiredMarks.push(node);
    }
    syncChildren(marks, desiredMarks);
    desiredLayers.push(group);
  }
  syncChildren(root, desiredLayers);
}

/**
 * 迁移期完整 SVG 文档：导出/视觉对照使用，仍在图层内合成几何、文字和透明度，
 * 因此导出结果与迁移前保持一致。
 */
export function drawBoard(board: SVGSVGElement, project: Project, view: BoardView = {}): void {
  const {temporaryMark = null, temporaryShape = null, selectedMark = null, selectedShapes = []} = view;
  const gridId = `sim-sketch-grid-${++patternSerial}`;
  const dots = svgElement('pattern', {id: gridId, width: gridSpec.spacing, height: gridSpec.spacing,
    patternUnits: 'userSpaceOnUse'},
    [svgElement('circle', {cx: gridSpec.origin[0], cy: gridSpec.origin[1], r: gridSpec.radius,
      fill: cssColor(gridSpec.dot)})]);
  const layers = project.layers.length ? project.layers : [{id: defaultLayerId, name: '图层 1', opacity: 1}];
  const groups = layers.map(layer => {
    const reference = project.reference && layer.id === project.referenceLayerId
      ? referenceElement(project.reference) : null;
    if (reference) reference.setAttribute('pointer-events', 'none');
    const shapes = svgElement('g', {'data-shapes': ''},
      (project.shapes ?? []).filter(shape => (shape.layerId ?? defaultLayerId) === layer.id)
        .map(shape => sketchShape(shape, selectedShapes.includes(shape.id), false)));
    const marks = svgElement('g', {'data-marks': ''},
      project.marks.filter(mark => (mark.layerId ?? defaultLayerId) === layer.id)
        .map(mark => annotation(mark, mark.id === selectedMark, false)));
    if (temporaryShape && (temporaryShape.layerId ?? defaultLayerId) === layer.id) {
      shapes.append(sketchShape(temporaryShape, false, false));
    }
    if (temporaryMark && (temporaryMark.layerId ?? defaultLayerId) === layer.id) {
      marks.append(annotation(temporaryMark, false, false));
    }
    return layerGroup(layer.id, layer.opacity ?? 1, reference ? [reference, shapes, marks] : [shapes, marks]);
  });
  const background = svgElement('rect', {class: 'board-geometry', x: -10000, y: -10000, width: 20000,
    height: 20000, fill: cssColor(gridSpec.background)});
  const grid = svgElement('rect', {class: 'board-geometry', x: -10000, y: -10000, width: 20000,
    height: 20000, fill: `url(#${gridId})`});
  board.replaceChildren(svgElement('defs', {}, [dots]), background, grid, ...groups);
}


