import {bitmap} from './reference.ts';
import {markColor, markLegend} from './project.ts';
import type {Project} from './project.ts';
import {renderSvgDocument} from './svg-document.ts';

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

function snapshot(host: ExportHost): SVGSVGElement {
  return renderSvgDocument(host.project(), host.board.getAttribute('viewBox') ?? '0 0 960 600');
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
  copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  copy.setAttribute('width', '960');
  copy.setAttribute('height', '600');
  const output = '<?xml version="1.0" encoding="UTF-8"?>' + new XMLSerializer().serializeToString(copy);
  const url = URL.createObjectURL(new Blob([output], {type: 'image/svg+xml'}));
  download(url, 'sim-sketch.svg');
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function exportJson(host: ExportHost): void {
  const project = host.project();
  const view = host.board.viewBox.baseVal;
  const output = {version: 1, coordinateSystem: 'image-pixels', width: 960, height: 600,
    viewBox: [view.x, view.y, view.width, view.height], ...project,
    legend: markLegend(project.marks), marks: project.marks.map(mark => ({...mark, color: markColor(mark)}))};
  const url = URL.createObjectURL(new Blob([JSON.stringify(output, null, 2)], {type: 'application/json'}));
  download(url, 'sim-sketch.json');
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
