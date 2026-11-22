import {shapePoints} from './geometry.ts';
import type {Point, Shape} from './geometry.ts';
import type {Mark, Project} from './project.ts';
import type {RenderViewport} from './renderer.ts';

function objectPoints(object: Mark | Shape): Point[] {
  if ('shape' in object) {
    switch (object.shape) {
      case 'pen':
        return object.points;
      case 'region':
      case 'arrow':
        return [object.a, object.b];
      case 'text':
        return [object.a];
    }
  }
  return shapePoints(object);
}

/** 画板当前 viewBox → 三个渲染后端共用的视口描述。 */
export function sceneViewport(board: SVGSVGElement): RenderViewport {
  const rect = board.getBoundingClientRect();
  const view = board.viewBox.baseVal;
  const width = Math.max(1, view.width || 960);
  const height = Math.max(1, view.height || 600);
  const cssWidth = rect.width || width;
  const cssHeight = rect.height || height;
  return {x: view.x, y: view.y, width, height, cssWidth, cssHeight,
    dpr: Math.min(devicePixelRatio || 1, 2), pixelsPerWorldUnit: cssWidth / width};
}

/** 窗口比例变化时，让靠近画板边缘的对象仍然可见。 */
export function fitBoardView(board: SVGSVGElement, project: Project): {width: number; height: number} {
  const {width, height} = board.getBoundingClientRect();
  if (!width || !height) return {width: 0, height: 0};
  let halfWidth = 480;
  let halfHeight = 300;
  for (const object of [...project.marks, ...project.shapes]) {
    for (const point of objectPoints(object)) {
      halfWidth = Math.max(halfWidth, Math.abs(point[0] - 480) + 24);
      halfHeight = Math.max(halfHeight, Math.abs(point[1] - 300) + 24);
    }
  }
  const viewWidth = Math.max(halfWidth * 2, halfHeight * 2 * width / height);
  const viewHeight = Math.max(halfHeight * 2, halfWidth * 2 * height / width);
  board.setAttribute('viewBox', `${(960 - viewWidth) / 2} ${(600 - viewHeight) / 2} ${viewWidth} ${viewHeight}`);
  return {width, height};
}
