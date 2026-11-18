import {defaultLayerId, markColor} from './project.js';

const namespace = 'http://www.w3.org/2000/svg';
export const paper = {background: '#fbfcfe', dot: '#b6c3dd'};

function svg(tag, attributes = {}, children = []) {
  const node = document.createElementNS(namespace, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  node.append(...children);
  return node;
}

export function boardPoint(board, event) {
  const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(board.getScreenCTM().inverse());
  return [Math.round(point.x), Math.round(point.y)];
}

function demoGeometry() {
  const group = svg('g');
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

export function markGeometry(mark, selected) {
  const color = markColor(mark);
  switch (mark.shape) {
    case 'pen':
      return {color, width: selected ? 6 : 4, points: mark.points};
    case 'region': {
      const {a, b} = mark;
      return {color, width: selected ? 5 : 3, center: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2],
        radii: [Math.max(3, Math.abs(a[0] - b[0]) / 2), Math.max(3, Math.abs(a[1] - b[1]) / 2)],
        fill: selected ? .23 : .11, dashed: mark.source === 'ai'};
    }
    case 'arrow': {
      const {a, b} = mark;
      const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
      const length = Math.min(21, Math.hypot(b[0] - a[0], b[1] - a[1]) * .47);
      const tip = offset => [b[0] - length * Math.cos(angle + offset), b[1] - length * Math.sin(angle + offset)];
      return {color, width: selected ? 7 : 5, points: [a, b, tip(.55), b, tip(-.55)]};
    }
    case 'text':
      return {color};
  }
}

function annotation(mark, selected) {
  const style = markGeometry(mark, selected);
  const {color, width: strokeWidth} = style;
  const group = svg('g', {'data-id': mark.id, 'stroke-linecap': 'round', 'stroke-linejoin': 'round'});
  let anchor;
  switch (mark.shape) {
    case 'pen': {
      anchor = mark.points[0];
      const trace = mark.points.length === 1 ? [anchor, [anchor[0] + .1, anchor[1]]] : mark.points;
      const points = trace.map(point => point.join(',')).join(' ');
      group.append(svg('polyline', {points, fill: 'none', stroke: 'transparent', 'stroke-width': 18}));
      group.append(svg('polyline', {points, fill: 'none', stroke: color, 'stroke-width': strokeWidth}));
      break;
    }
    case 'region': {
      const {a, b} = mark;
      anchor = [Math.min(a[0], b[0]), Math.min(a[1], b[1])];
      const {center: [cx, cy], radii: [rx, ry], fill, dashed} = style;
      group.append(svg('ellipse', {cx, cy, rx, ry, fill: color,
        'fill-opacity': fill, stroke: color, 'stroke-width': strokeWidth,
        'stroke-dasharray': dashed ? '9 5' : 'none'}));
      break;
    }
    case 'arrow': {
      const [a, b, left, , right] = style.points;
      anchor = a;
      const d = `M${a} L${b} M${left} L${b} L${right}`;
      group.append(svg('path', {d, fill: 'none', stroke: 'transparent', 'stroke-width': 22}));
      group.append(svg('path', {d, fill: 'none', stroke: color, 'stroke-width': strokeWidth}));
      break;
    }
    case 'text':
      anchor = mark.a;
      break;
  }
  const value = mark.value === null ? '' : ` ${mark.value} ${mark.unit}`;
  const label = (mark.label + value).trim();
  if (label && anchor && mark.shape === 'text') {
    const width = Array.from(label).reduce((sum, char) => sum + (char.codePointAt(0) > 255 ? 22 : 13), 0);
    group.append(svg('rect', {x: anchor[0] - 3, y: anchor[1] - 3, width: width + 6, height: 29,
      rx: 3, fill: 'transparent', stroke: selected ? '#3047cc' : 'none', 'stroke-width': 1.5, 'stroke-dasharray': '4 3'}));
    group.append(svg('text', {x: anchor[0], y: anchor[1], fill: color, 'font-size': 22,
      'font-family': 'system-ui, sans-serif', 'font-weight': 650, 'dominant-baseline': 'hanging',
      'paint-order': 'stroke', stroke: selected ? '#ffffff' : 'none', 'stroke-width': 3}, [label]));
  } else if (label && anchor) {
    const characters = Array.from(label);
    const visibleLabel = characters.length > 29 ? characters.slice(0, 28).join('') + '…' : label;
    const width = Math.min(665, Array.from(visibleLabel).reduce((total, char) => total + (char.charCodeAt(0) > 255 ? 24 : 13), 22));
    const x = Math.max(4, Math.min(956 - width, anchor[0] + (mark.shape === 'arrow' ? 10 : 0)));
    const y = anchor[1] - 9;
    group.append(svg('rect', {x, y: y - 25, width, height: 34, rx: 7,
      fill: '#ffffff', stroke: color, 'stroke-width': selected ? 2 : 1}));
    group.append(svg('text', {x: x + 9, y, fill: color, 'font-size': 22,
      'font-family': 'system-ui, sans-serif', 'font-weight': 650}, [visibleLabel]));
  }
  return group;
}

const boardLayers = new WeakMap();

export function drawBoard(board, project, temporary = null, selected = null) {
  let layers = boardLayers.get(board);
  if (!layers) {
    const dots = svg('pattern', {id: 'grid', width: 24, height: 24, patternUnits: 'userSpaceOnUse'},
      [svg('circle', {cx: 1.4, cy: 1.4, r: 1.25, fill: paper.dot})]);
    const marks = svg('g');
    board.replaceChildren(svg('defs', {}, [dots]),
      svg('rect', {class: 'board-geometry', x: -10000, y: -10000, width: 20000, height: 20000, fill: paper.background}),
      svg('rect', {class: 'board-geometry', x: -10000, y: -10000, width: 20000, height: 20000, fill: 'url(#grid)'}),
      marks);
    layers = {marks};
    boardLayers.set(board, layers);
  }
  if (layers.markValues !== project.marks || layers.layerValues !== project.layers || layers.referenceValue !== project.reference ||
      layers.referenceLayerId !== project.referenceLayerId || layers.selected !== selected) {
    const projectLayers = project.layers ?? [{id: defaultLayerId, opacity: 1}];
    layers.marks.replaceChildren(...projectLayers.map(layer => {
      const group = svg('g', {'data-layer-id': layer.id, opacity: layer.opacity ?? 1});
      if (project.reference && layer.id === project.referenceLayerId) {
        const reference = referenceLayer(project.reference);
        reference.setAttribute('pointer-events', 'none');
        group.append(reference);
      }
      group.append(...project.marks.filter(mark => (mark.layerId ?? defaultLayerId) === layer.id)
        .map(mark => annotation(mark, mark.id === selected)));
      return group;
    }));
    layers.markValues = project.marks;
    layers.layerValues = project.layers;
    layers.referenceValue = project.reference;
    layers.referenceLayerId = project.referenceLayerId;
    layers.selected = selected;
    layers.temporary = null;
  }
  layers.temporary?.remove();
  layers.temporary = temporary ? annotation(temporary, false) : null;
  if (layers.temporary) {
    const target = Array.from(layers.marks.children).find(group => group.dataset.layerId === temporary.layerId);
    (target ?? layers.marks).append(layers.temporary);
  }
}

function referenceLayer(reference) {
  if (reference === 'demo') return demoGeometry();
  if (reference) return svg('image', {href: reference, width: 960, height: 600});
  return null;
}

export async function referenceCanvas(reference) {
  const layer = referenceLayer(reference);
  if (!layer) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    canvas.getContext('2d');
    return canvas;
  }
  return rasterize(svg('svg', {viewBox: '0 0 960 600'}, [layer]));
}

async function rasterize(svgNode) {
  const copy = svgNode.cloneNode(true);
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
  canvas.getContext('2d').drawImage(image, 0, 0);
  return canvas;
}

export async function bitmap(svgNode, quality = 'image/png') {
  return (await rasterize(svgNode)).toDataURL(quality, .92);
}

export async function readReference(file) {
  const source = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = source;
    await image.decode();
    const scale = Math.min(1, 1920 / image.naturalWidth, 1200 / image.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
  } finally {
    URL.revokeObjectURL(source);
  }
}
