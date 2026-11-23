import {bitmap} from './reference.ts';
import {markColor, markLegend} from './project.ts';
import type {Project} from './project.ts';
import {renderSvgDocument} from './svg-document.ts';
import {fitWorldRect, exportViewBox} from './viewport.ts';

export interface ExportHost {
  board: SVGSVGElement;
  project(): Project;
  notice: HTMLElement;
}

function download(url: string, filename: string): void {
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
}

/** 导出永远使用内容适配 viewBox，实时缩放/平移不会泄漏到 SVG/PNG/JSON。 */
function snapshot(host: ExportHost): SVGSVGElement {
  const project = host.project();
  return renderSvgDocument(project, exportViewBox(project));
}

/** 复制 PNG 到剪贴板；不支持时退化为明确提示。 */
export async function copyPng(host: ExportHost): Promise<void> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
    host.notice.textContent = '当前浏览器不支持复制图片，请使用「文件 → 导出 PNG」。';
    return;
  }
  try {
    const blob = await (await fetch(await bitmap(snapshot(host)))).blob();
    await navigator.clipboard.write([new ClipboardItem({'image/png': blob})]);
    host.notice.textContent = '画布图片已复制到剪贴板。';
  } catch {
    host.notice.textContent = '复制图片失败，请检查浏览器的剪贴板权限，或使用「文件 → 导出 PNG」。';
  }
}

export async function exportPng(host: ExportHost): Promise<void> {
  try {
    download(await bitmap(snapshot(host)), 'sim-sketch.png');
  } catch {
    host.notice.textContent = 'PNG 导出失败。';
  }
}

export function exportSvg(host: ExportHost): void {
  const copy = snapshot(host);
  const {width, height} = exportSize(host.project());
  copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  copy.setAttribute('width', String(width));
  copy.setAttribute('height', String(height));
  const output = '<?xml version="1.0" encoding="UTF-8"?>' + new XMLSerializer().serializeToString(copy);
  const url = URL.createObjectURL(new Blob([output], {type: 'image/svg+xml'}));
  download(url, 'sim-sketch.svg');
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function exportJson(host: ExportHost): void {
  const project = host.project();
  const view = exportViewBox(project).split(' ').map(Number);
  const size = exportSize(project);
  // 派生字段放在项目之后，避免外部/旧数据里的 viewBox/width/height 覆盖导出视口。
  const output = {version: 1, coordinateSystem: 'image-pixels', ...project,
    width: size.width, height: size.height, viewBox: view,
    legend: markLegend(project.marks), marks: project.marks.map(mark => ({...mark, color: markColor(mark)}))};
  const url = URL.createObjectURL(new Blob([JSON.stringify(output, null, 2)], {type: 'application/json'}));
  download(url, 'sim-sketch.json');
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 导出画布尺寸跟随内容包围盒；空项目仍是 960×600。 */
function exportSize(project: Project): {width: number; height: number} {
  const view = fitWorldRect(project, 960, 600);
  return {width: Math.max(1, Math.ceil(view.width)), height: Math.max(1, Math.ceil(view.height))};
}
