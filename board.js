const namespace = 'http://www.w3.org/2000/svg';
const colors = {note: '#fbcc81', fixed: '#75dcb8', force: '#c5b6ff', pressure: '#8dd5ff', other: '#fbcc81'};

function svg(tag, attributes = {}, children = []) {
  const node = document.createElementNS(namespace, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  node.append(...children);
  return node;
}

export function boardPoint(board, event) {
  const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(board.getScreenCTM().inverse());
  return [Math.round(Math.max(0, Math.min(960, point.x))), Math.round(Math.max(0, Math.min(600, point.y)))];
}

function demoGeometry() {
  const group = svg('g');
  group.innerHTML = `
    <defs>
      <linearGradient id="base" x2=".25" y2="1" gradientUnits="objectBoundingBox">
        <stop stop-color="#7f97af"/><stop offset="1" stop-color="#526a84"/>
      </linearGradient>
    </defs>
    <ellipse cx="492" cy="454" rx="307" ry="56" fill="#0f1622" opacity=".7"/>
    <path d="M260 368 300 335 681 335 770 391 717 440 319 440 260 403Z" fill="#354961" stroke="#9bb0c4" stroke-width="2"/>
    <path d="M260 368 300 335 681 335 770 391 717 416 319 416Z" fill="url(#base)" stroke="#a9bdcf" stroke-width="2"/>
    <path d="M319 416v24m398-24v24m53-49v19l-53 30" fill="none" stroke="#9bb0c4" stroke-width="2"/>
    <path d="M273 187 318 151 412 198 412 356 366 396 273 353Z" fill="#435b74" stroke="#aac0d4" stroke-width="2"/>
    <path d="M273 187 318 151 412 198 366 232Z" fill="#afc0d0" stroke="#bccddd" stroke-width="2"/>
    <path d="M273 187 366 232 366 396 273 353Z" fill="url(#base)" stroke="#a9bed4" stroke-width="2"/>
    <path d="M366 235 411 199 593 371 545 400 366 400Z" fill="#8099b2" stroke="#bdd0df" stroke-width="2"/>
    <path d="M366 235 545 400 366 400Z" fill="#5e7893" stroke="#9fb8ce" stroke-width="2"/>
    <g fill="#202e40" stroke="#b3c7d7" stroke-width="2">
      <ellipse cx="311" cy="241" rx="12" ry="16" transform="rotate(-20 311 241)"/>
      <ellipse cx="311" cy="325" rx="12" ry="16" transform="rotate(-20 311 325)"/>
      <ellipse cx="655" cy="377" rx="20" ry="8"/>
      <ellipse cx="703" cy="392" rx="20" ry="8"/>
    </g>
    <g transform="translate(85 506)" stroke-width="3" fill="none">
      <path d="M0 0v-55" stroke="#dca8ff"/><path d="M0 0l64 6" stroke="#eba08d"/><path d="M0 0l-30 27" stroke="#8fd6b1"/>
      <g font-size="16" font-family="system-ui" stroke="none"><text x="-5" y="-63" fill="#dca8ff">Z</text><text x="72" y="12" fill="#eba08d">X</text><text x="-44" y="39" fill="#8fd6b1">Y</text></g>
    </g>`;
  return group;
}

function annotation(mark, selected) {
  const color = colors[mark.kind];
  const group = svg('g', {'data-id': mark.id, 'stroke-linecap': 'round', 'stroke-linejoin': 'round'});
  let anchor;
  switch (mark.shape) {
    case 'pen': {
      anchor = mark.points[0];
      const trace = mark.points.length === 1 ? [anchor, [anchor[0] + .1, anchor[1]]] : mark.points;
      const points = trace.map(point => point.join(',')).join(' ');
      group.append(svg('polyline', {points, fill: 'none', stroke: 'transparent', 'stroke-width': 18}));
      group.append(svg('polyline', {points, fill: 'none', stroke: color, 'stroke-width': selected ? 6 : 4}));
      break;
    }
    case 'region': {
      const {a, b} = mark;
      anchor = [Math.min(a[0], b[0]), Math.min(a[1], b[1])];
      group.append(svg('ellipse', {cx: (a[0] + b[0]) / 2, cy: (a[1] + b[1]) / 2,
        rx: Math.max(3, Math.abs(a[0] - b[0]) / 2), ry: Math.max(3, Math.abs(a[1] - b[1]) / 2),
        fill: color, 'fill-opacity': selected ? .23 : .11, stroke: color, 'stroke-width': selected ? 5 : 3,
        'stroke-dasharray': mark.source === 'ai' ? '9 5' : 'none'}));
      break;
    }
    case 'arrow': {
      const {a, b} = mark;
      anchor = a;
      const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
      const length = Math.min(21, Math.hypot(b[0] - a[0], b[1] - a[1]) * .47);
      const tip = offset => [b[0] - length * Math.cos(angle + offset), b[1] - length * Math.sin(angle + offset)];
      const d = `M${a} L${b} M${tip(.55)} L${b} L${tip(-.55)}`;
      group.append(svg('path', {d, fill: 'none', stroke: 'transparent', 'stroke-width': 22}));
      group.append(svg('path', {d, fill: 'none', stroke: color, 'stroke-width': selected ? 7 : 5}));
      break;
    }
    case 'text':
      anchor = mark.a;
      break;
  }
  const value = mark.value === null ? '' : ` ${mark.value} ${mark.unit}`;
  const label = (mark.label + value).trim();
  if (label && anchor) {
    const characters = Array.from(label);
    const visibleLabel = characters.length > 29 ? characters.slice(0, 28).join('') + '…' : label;
    const width = Math.min(665, Array.from(visibleLabel).reduce((total, char) => total + (char.charCodeAt(0) > 255 ? 24 : 13), 22));
    const x = Math.max(4, Math.min(956 - width, anchor[0] + (mark.shape === 'arrow' ? 10 : 0)));
    const y = Math.min(591, Math.max(30, anchor[1] - 9));
    group.append(svg('rect', {x, y: y - 25, width, height: 34, rx: 7,
      fill: '#151c2a', stroke: color, 'stroke-width': selected ? 2 : 1}));
    group.append(svg('text', {x: x + 9, y, fill: color, 'font-size': 22,
      'font-family': 'system-ui, sans-serif', 'font-weight': 650}, [visibleLabel]));
  }
  return group;
}

export function drawBoard(board, project, temporary = null, selected = null) {
  const dots = svg('pattern', {id: 'grid', width: 24, height: 24, patternUnits: 'userSpaceOnUse'},
    [svg('circle', {cx: 1.4, cy: 1.4, r: 1.25, fill: '#344457'})]);
  board.replaceChildren(svg('defs', {}, [dots]),
    svg('rect', {width: 960, height: 600, fill: '#151e2a'}),
    svg('rect', {width: 960, height: 600, fill: 'url(#grid)'}));
  if (project.reference === 'demo') board.append(demoGeometry());
  else if (project.reference) board.append(svg('image', {href: project.reference, width: 960, height: 600}));
  for (const mark of project.marks) board.append(annotation(mark, mark.id === selected));
  if (temporary) board.append(annotation(temporary, false));
}

export async function bitmap(svgNode, quality = 'image/png') {
  const copy = svgNode.cloneNode(true);
  copy.setAttribute('width', '960');
  copy.setAttribute('height', '600');
  const source = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(copy));
  const image = new Image();
  image.src = source;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = 960;
  canvas.height = 600;
  canvas.getContext('2d').drawImage(image, 0, 0);
  return canvas.toDataURL(quality, .92);
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
