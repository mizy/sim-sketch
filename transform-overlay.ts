import {accent} from './theme.ts';
import {svgElement} from './svg-dom.ts';
import {frameCorners, frameHandlePoint, frameHandles, frameRotationPoint} from './transform.ts';
import type {TransformFrame} from './transform.ts';
import {screenConstant} from './viewport.ts';

const HANDLE_SIZE_PX = 9;
const ROTATE_GAP_PX = 28;
const STROKE_PX = 1.5;
/** 产品要求桌面命中区 ≥24 CSS px、移动端 ≥32 CSS px。 */
const HIT_DESKTOP_PX = 24;
const HIT_TOUCH_PX = 32;

/**
 * @entry 选中框、8 个局部轴缩放手柄与旋转手柄。
 * 手柄位置跟随 frame.rotation 旋转；命中区按屏幕像素折算，10% 与 800% 下一致。
 * 该层只读项目预览，不写项目、不产生 undo。
 */
export function drawTransformHandles(board: SVGSVGElement, frame: TransformFrame | null,
  zoom: number): void {
  let group = board.querySelector<SVGGElement>(':scope > [data-transform-handles]');
  if (!group) {
    group = svgElement('g', {'data-transform-handles': ''});
    board.append(group);
  }
  if (board.lastElementChild !== group) board.append(group);
  if (!frame) {
    group.replaceChildren();
    group.setAttribute('visibility', 'hidden');
    return;
  }
  group.setAttribute('visibility', 'visible');
  const size = screenConstant(HANDLE_SIZE_PX, zoom);
  const stroke = screenConstant(STROKE_PX, zoom);
  const gap = screenConstant(ROTATE_GAP_PX, zoom);
  const hit = screenConstant(touchPointer() ? HIT_TOUCH_PX : HIT_DESKTOP_PX, zoom);
  const dash = screenConstant(4, zoom);
  const gapDash = screenConstant(3, zoom);
  const rotationDegrees = frame.rotation * 180 / Math.PI;
  const corners = frameCorners(frame).map(([x, y]) => `${x},${y}`).join(' ');
  const children: SVGElement[] = [
    svgElement('polygon', {points: corners, fill: 'none', stroke: accent, 'stroke-width': stroke,
      'stroke-dasharray': `${dash} ${gapDash}`, 'pointer-events': 'none'})
  ];

  if (frame.rotatable) {
    const top = frameHandlePoint(frame, 'n');
    const handle = frameRotationPoint(frame, gap);
    children.push(
      svgElement('line', {x1: top[0], y1: top[1], x2: handle[0], y2: handle[1],
        stroke: accent, 'stroke-width': stroke, 'pointer-events': 'none'}),
      svgElement('circle', {cx: handle[0], cy: handle[1], r: size * .56, fill: '#ffffff', stroke: accent,
        'stroke-width': stroke, 'pointer-events': 'none'}),
      svgElement('circle', {cx: handle[0], cy: handle[1], r: hit / 2, fill: 'transparent', stroke: 'none',
        'pointer-events': 'all', 'data-transform-handle': 'rotate'})
    );
  }

  for (const handle of frameHandles(frame)) {
    const [x, y] = frameHandlePoint(frame, handle);
    const transform = rotationDegrees ? `rotate(${rotationDegrees} ${x} ${y})` : undefined;
    children.push(
      svgElement('rect', {x: x - size / 2, y: y - size / 2, width: size, height: size,
        rx: size * .12, fill: '#ffffff', stroke: accent, 'stroke-width': stroke, 'pointer-events': 'none',
        ...(transform ? {transform} : {})}),
      svgElement('circle', {cx: x, cy: y, r: hit / 2,
        fill: 'transparent', stroke: 'none', 'pointer-events': 'all', 'data-transform-handle': handle})
    );
  }
  group.replaceChildren(...children);
}

function touchPointer(): boolean {
  return typeof window !== 'undefined' && Boolean(window.matchMedia?.('(pointer: coarse)').matches);
}
