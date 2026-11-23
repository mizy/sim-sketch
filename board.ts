import {markGeometry} from './annotations.ts';
import {bezierPathData} from './bezier.ts';
import {normalizeShapeStrokeWidth} from './mark-width.ts';
import {defaultLayerId, markColor} from './project.ts';
import type {Mark, Project} from './project.ts';
import {ellipseRing, shapeClosed, shapePath, sketchInk} from './geometry.ts';
import type {Point, Shape} from './geometry.ts';
import {referenceElement} from './reference.ts';
import {gridSpec} from './scene.ts';
import {TEXT_CHIP_ASCII_WIDTH, TEXT_CHIP_FONT_SIZE, TEXT_CHIP_MIN_PADDING, TEXT_CHIP_WIDE_WIDTH,
  textLabelBox} from './text-metrics.ts';
import {cssColor} from './theme.ts';
import {ringsPath, svgElement} from './svg-dom.ts';
import type {SvgChild} from './svg-dom.ts';


export interface BoardView {
  temporaryMark?: Mark | null;
  temporaryShape?: Shape | null;
  selectedMark?: string | null;
  selectedShapes?: readonly string[];
  /** 导出/快照背景覆盖范围；缺省用 960×600 基准画布。 */
  backdrop?: {x: number; y: number; width: number; height: number};
}

export interface OverlayView {
  selectedMark?: string | null;
  selectedShapes?: readonly string[];
  /** 导出时没有交互，不需要透明命中代理。 */
  hitProxies?: boolean;
  /** 1 个 CSS 像素对应的世界单位（1/zoom）；命中代理按屏幕尺寸保底。 */
  hitScale?: number;
}

let patternSerial = 0;


function pointText(points: readonly Point[]): string {
  return points.map(point => point.join(',')).join(' ');
}

/**
 * 命中代理至少保持 basePx 个 CSS 像素，粗线则跟随自身线宽。
 * 10% 缩放下仍约 18 CSS px，800% 下不会因为世界单位放大而过度遮挡邻居。
 */
function hitWidth(basePx: number, strokeWidth: number, hitScale: number): number {
  // 防御未经 normalizeProject 的脏数据：NaN/Infinity 不能把命中路径一起拖成不可用。
  return Math.max(basePx * hitScale, Number.isFinite(strokeWidth) ? strokeWidth : 0);
}

function shapeStrokeWidth(shape: Shape): number {
  return normalizeShapeStrokeWidth(shape.strokeWidth);
}

function hitPath(d: string, closed: boolean, strokeWidth: number): SVGPathElement {
  return svgElement('path', {d, fill: closed ? 'transparent' : 'none', 'fill-rule': 'evenodd',
    stroke: 'transparent', 'stroke-width': strokeWidth, 'pointer-events': 'all'});
}

function annotation(mark: Mark, selected: boolean, overlayOnly: boolean, hitScale = 1): SVGGElement {
  const group = svgElement('g', {'data-id': mark.id, 'stroke-linecap': 'round', 'stroke-linejoin': 'round'});
  let anchor: Point | undefined;
  switch (mark.shape) {
    case 'pen': {
      const style = markGeometry(mark, selected);
      anchor = style.points[0];
      const trace = style.points.length === 1 ? [anchor, [anchor[0] + .1, anchor[1]] as Point] : style.points;
      const points = pointText(trace);
      group.append(svgElement('polyline', {points, fill: 'none', stroke: 'transparent',
        'stroke-width': hitWidth(18, style.width, hitScale), 'pointer-events': overlayOnly ? 'stroke' : 'none'}));
      if (!overlayOnly) {
        // 拟合笔迹按可编辑贝塞尔导出；points 仍是同一曲线的离散采样，命中/包围盒不受影响。
        group.append(style.curve
          ? svgElement('path', {d: bezierPathData(style.curve), fill: 'none', stroke: style.color,
            'stroke-width': style.width})
          : svgElement('polyline', {points, fill: 'none', stroke: style.color, 'stroke-width': style.width}));
      }
      break;
    }
    case 'region': {
      const style = markGeometry(mark, selected);
      const {a, b} = mark;
      anchor = [Math.min(a[0], b[0]), Math.min(a[1], b[1])];
      const [cx, cy] = style.center;
      const [rx, ry] = style.radii;
      if (style.rotation) {
        const d = ringsPath([ellipseRing(style.center, style.radii, style.rotation)]);
        group.append(svgElement('path', {d,
          fill: overlayOnly ? 'transparent' : style.color,
          'fill-opacity': overlayOnly ? 0 : style.fill,
          stroke: overlayOnly ? 'transparent' : style.color,
          'stroke-width': overlayOnly ? hitWidth(18, style.width, hitScale) : style.width,
          'stroke-dasharray': overlayOnly || !style.dashed ? 'none' : '9 5',
          'pointer-events': overlayOnly ? 'all' : 'none'}));
      } else if (overlayOnly) {
        group.append(svgElement('ellipse', {cx, cy, rx, ry, fill: 'transparent', stroke: 'transparent',
          'stroke-width': hitWidth(18, style.width, hitScale), 'pointer-events': 'all'}));
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
      group.append(svgElement('path', {d, fill: 'none', stroke: 'transparent',
        'stroke-width': hitWidth(22, style.width, hitScale), 'pointer-events': overlayOnly ? 'stroke' : 'none'}));
      if (!overlayOnly) group.append(svgElement('path', {d, fill: 'none', stroke: style.color, 'stroke-width': style.width}));
      break;
    }
    case 'text':
      anchor = mark.a;
      break;
  }
  const value = mark.value === null ? '' : ` ${mark.value} ${mark.unit}`;
  const label = (mark.label + value).trim();
  const textBox = mark.shape === 'text' ? textLabelBox(mark) : null;
  if (textBox && anchor && mark.shape === 'text') {
    const style = markGeometry(mark, selected);
    // 文字命中框按 8 CSS px 外扩，10% 缩放下仍能点中；导出不生成该代理。
    if (overlayOnly) {
      const pad = 8 * hitScale;
      group.append(svgElement('rect', {x: textBox.x - pad, y: textBox.y - pad,
        width: textBox.width + pad * 2, height: textBox.height + pad * 2,
        fill: 'transparent', stroke: 'none', 'pointer-events': 'all'}));
    }
    if (textBox.label) {
      const border = overlayOnly ? 1.5 * hitScale : 1.5;
      group.append(svgElement('rect', {x: textBox.x, y: textBox.y, width: textBox.width, height: textBox.height,
        rx: 3, fill: 'transparent', stroke: selected ? '#3047cc' : 'none', 'stroke-width': border,
        'stroke-dasharray': `${4 * (overlayOnly ? hitScale : 1)} ${3 * (overlayOnly ? hitScale : 1)}`}));
      group.append(svgElement('text', {x: anchor[0], y: anchor[1], fill: style.color,
        'font-size': style.fontSize,
        'font-family': 'system-ui, sans-serif', 'font-weight': 650, 'dominant-baseline': 'hanging',
        'paint-order': 'stroke', stroke: selected ? '#ffffff' : 'none',
        'stroke-width': overlayOnly ? 3 * hitScale : 3}, [textBox.label]));
    }
  } else if (label && anchor) {
    const color = markColor(mark);
    const characters = Array.from(label);
    const visibleLabel = characters.length > 29 ? characters.slice(0, 28).join('') + '…' : label;
    const width = Math.min(665, Array.from(visibleLabel).reduce((total, char) =>
      total + ((char.codePointAt(0) ?? 0) > 255 ? TEXT_CHIP_WIDE_WIDTH : TEXT_CHIP_ASCII_WIDTH),
      TEXT_CHIP_MIN_PADDING));
    const x = Math.max(4, Math.min(956 - width, anchor[0] + (mark.shape === 'arrow' ? 10 : 0)));
    const y = anchor[1] - 9;
    group.append(svgElement('rect', {x, y: y - 25, width, height: 34, rx: 7,
      fill: '#ffffff', stroke: color, 'stroke-width': selected ? 2 : 1}));
    group.append(svgElement('text', {x: x + 9, y, fill: color, 'font-size': TEXT_CHIP_FONT_SIZE,
      'font-family': 'system-ui, sans-serif', 'font-weight': 650}, [visibleLabel]));
  }
  return group;
}

function sketchShape(shape: Shape, selected: boolean, overlayOnly: boolean, hitScale = 1): SVGGElement {
  const group = svgElement('g', {'data-shape-id': shape.id});
  const d = shapePath(shape);
  if (!d) return group;
  const strokeWidth = shapeStrokeWidth(shape);
  if (overlayOnly) {
    group.append(hitPath(d, shapeClosed(shape), hitWidth(18, strokeWidth, hitScale)));
    return group;
  }
  const closed = shapeClosed(shape);
  const color = shape.color ?? sketchInk;
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

const hitShapeSources = new WeakMap<SVGGElement, {shape: Shape; hitScale: number}>();
const markNodeSources = new WeakMap<SVGGElement, {mark: Mark; selected: boolean; hitScale: number}>();

function updateShapeHit(node: SVGGElement, shape: Shape, hitScale: number): void {
  // 未变化的图元保持同一 shape 引用；缩放变化时只更新命中宽度，不重建 path 内容。
  const source = hitShapeSources.get(node);
  if (source?.shape === shape && source.hitScale === hitScale) return;
  hitShapeSources.set(node, {shape, hitScale});
  const path = node.firstElementChild as SVGPathElement | null;
  const d = shapePath(shape);
  if (!d) {
    path?.remove();
    return;
  }
  if (!path) {
    node.append(hitPath(d, shapeClosed(shape), hitWidth(18, shapeStrokeWidth(shape), hitScale)));
    return;
  }
  path.setAttribute('d', d);
  path.setAttribute('fill', shapeClosed(shape) ? 'transparent' : 'none');
  path.setAttribute('fill-rule', 'evenodd');
  path.setAttribute('stroke-width', String(hitWidth(18, shapeStrokeWidth(shape), hitScale)));
}

/**
 * @entry 文字/标签与交互命中层。GPU/Canvas2D 模式下只画这一层；SVG 模式叠加在几何之上。
 * 命中代理按 shape id 增量复用，避免 2000 图元时每个 pointermove 重建整层 DOM。
 */
export function drawOverlay(board: SVGSVGElement, project: Project, view: OverlayView = {}): void {
  const {selectedMark = null, selectedShapes = [], hitProxies = true, hitScale = 1} = view;
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
      const node = existing.get(shape.id) ?? sketchShape(shape, selectedShapes.includes(shape.id), true, hitScale);
      existing.delete(shape.id);
      updateShapeHit(node, shape, hitScale);
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
      if (cached && source?.mark === mark && source.selected === selected && source.hitScale === hitScale) {
        desiredMarks.push(cached);
        continue;
      }
      const node = annotation(mark, selected, true, hitScale);
      markNodeSources.set(node, {mark, selected, hitScale});
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
  const {temporaryMark = null, temporaryShape = null, selectedMark = null, selectedShapes = [],
    backdrop = {x: 0, y: 0, width: 960, height: 600}} = view;
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
  // 背景/网格必须覆盖导出包围盒，而不是固定的 20000 单位窗口。
  const background = svgElement('rect', {class: 'board-geometry', x: backdrop.x, y: backdrop.y,
    width: backdrop.width, height: backdrop.height, fill: cssColor(gridSpec.background)});
  const grid = svgElement('rect', {class: 'board-geometry', x: backdrop.x, y: backdrop.y,
    width: backdrop.width, height: backdrop.height, fill: `url(#${gridId})`});
  board.replaceChildren(svgElement('defs', {}, [dots]), background, grid, ...groups);
}


