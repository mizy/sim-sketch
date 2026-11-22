import {svgElement} from './svg-dom.ts';

function demoGeometry(): SVGGElement {
  const group = svgElement('g');
  group.innerHTML = `
    <defs>
      <linearGradient id="base" x2=".25" y2="1" gradientUnits="objectBoundingBox">
        <stop stop-color="#dce5f1"/><stop offset="1" stop-color="#a8bdd6"/>
      </linearGradient>
    </defs>
    <ellipse cx="492" cy="454" rx="307" ry="56" fill="#a7b8d1" opacity=".22"/>
    <path d="M260 368 300 335 681 335 770 391 717 440 319 440 260 403Z" fill="#93abc6" stroke="#496583" stroke-width="2"/>
    <path d="M260 368 300 335 681 335 770 391 717 416 319 416Z" fill="url(#base)" stroke="#4a6686" stroke-width="2"/>
    <path d="M319 416v24m398-24v24m53-49v19l-53 30" fill="none" stroke="#496583" stroke-width="2"/>
    <path d="M273 187 318 151 412 198 412 356 366 396 273 353Z" fill="#95acc8" stroke="#536c8b" stroke-width="2"/>
    <path d="M273 187 318 151 412 198 366 232Z" fill="#edf1f7" stroke="#526b89" stroke-width="2"/>
    <path d="M273 187 366 232 366 396 273 353Z" fill="url(#base)" stroke="#476583" stroke-width="2"/>
    <path d="M366 235 411 199 593 371 545 400 366 400Z" fill="#d0dbea" stroke="#52708e" stroke-width="2"/>
    <path d="M366 235 545 400 366 400Z" fill="#93aaca" stroke="#526b8a" stroke-width="2"/>
    <g fill="#728aab" stroke="#496484" stroke-width="2">
      <ellipse cx="311" cy="241" rx="12" ry="16" transform="rotate(-20 311 241)"/>
      <ellipse cx="311" cy="325" rx="12" ry="16" transform="rotate(-20 311 325)"/>
      <ellipse cx="655" cy="377" rx="20" ry="8"/>
      <ellipse cx="703" cy="392" rx="20" ry="8"/>
    </g>
    <g transform="translate(85 506)" stroke-width="3" fill="none">
      <path d="M0 0v-55" stroke="#3c58bd"/><path d="M0 0l64 6" stroke="#a84c31"/><path d="M0 0l-30 27" stroke="#197866"/>
      <g font-size="16" font-family="system-ui" stroke="none"><text x="-5" y="-63" fill="#3c58bd">Z</text><text x="72" y="12" fill="#a84c31">X</text><text x="-44" y="39" fill="#197866">Y</text></g>
    </g>`;
  return group;
}

export function referenceElement(reference: string | null): SVGGElement | SVGImageElement | null {
  if (reference === 'demo') return demoGeometry();
  if (reference) return svgElement('image', {href: reference, width: 960, height: 600});
  return null;
}

export async function referenceCanvas(reference: string | null): Promise<HTMLCanvasElement> {
  const layer = referenceElement(reference);
  if (!layer) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    return canvas;
  }
  return rasterize(svgElement('svg', {viewBox: '0 0 960 600'}, [layer]));
}

export async function rasterize(svgNode: SVGSVGElement): Promise<HTMLCanvasElement> {
  const copy = svgNode.cloneNode(true) as SVGSVGElement;
  const view = svgNode.viewBox.baseVal;
  const width = 1200;
  const height = Math.max(1, Math.round(width * view.height / view.width));
  copy.setAttribute('width', String(width));
  copy.setAttribute('height', String(height));
  const source = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(copy));
  const image = new Image();
  image.src = source;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')!.drawImage(image, 0, 0);
  return canvas;
}

export async function bitmap(svgNode: SVGSVGElement, quality = 'image/png'): Promise<string> {
  return (await rasterize(svgNode)).toDataURL(quality, .92);
}

export async function readReference(file: File): Promise<string> {
  const source = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = source;
    await image.decode();
    const scale = Math.min(1, 1920 / image.naturalWidth, 1200 / image.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    canvas.getContext('2d')!.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
  } finally {
    URL.revokeObjectURL(source);
  }
}
