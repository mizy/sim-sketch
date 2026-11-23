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
  const backdrop = parseViewBox(viewBox);
  drawBoard(svg, project, backdrop ? {...view, backdrop} : view);
  return svg;
}

/** viewBox → 背景覆盖范围；非法值回退基准画布，避免导出出现固定 20000 窗口。 */
function parseViewBox(value: string): {x: number; y: number; width: number; height: number} | null {
  const [x, y, width, height] = value.trim().split(/\s+/).map(Number);
  return [x, y, width, height].every(Number.isFinite) && width > 0 && height > 0
    ? {x, y, width, height} : null;
}
