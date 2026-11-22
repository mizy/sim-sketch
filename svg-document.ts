import {drawBoard} from './board.ts';
import type {BoardView} from './board.ts';
import type {Project} from './project.ts';
import {svgElement} from './svg-dom.ts';

/**
 * 完整 SVG 文档导出：保持旧版图层内文字/几何合成次序。
 * 渲染器只消费 RenderScene，文档导出不属于 WebGPU/Canvas2D 契约。
 */
export function renderSvgDocument(project: Project, viewBox = '0 0 960 600',
  view: BoardView = {}): SVGSVGElement {
  const svg = svgElement('svg', {xmlns: 'http://www.w3.org/2000/svg', viewBox});
  drawBoard(svg, project, view);
  return svg;
}
