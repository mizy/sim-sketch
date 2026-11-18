import {bitmap, boardPoint, drawBoard, readReference} from './board.js';
import {demoProject, emptyProject, markColor, markKinds, markLegend, newLayer, newMark, normalizeProject, readProject, saveProject} from './project.js';
import {createGpuBoard} from './gpu-board.js';

const $ = selector => document.querySelector(selector);
const board = $('#board');
const status = $('#status');
const annotations = $('#annotations');
const notice = $('#notice');
const editDialog = $('#edit-dialog');
const editForm = $('#edit-form');
const presets = $('#preset-colors');
const customColor = $('#custom-color');
const customBrush = customColor.closest('label');
const brushLabel = $('#brush-label');
const textInput = $('#canvas-text');
let inlineText = null;

let project;
let paintGpu;
let selection = null;
let drawing = null;
let editMark = null;
let activeLayerId = null;
let opacityPreview = null;
let tool = 'pen';
let brush = 'auto';
let revision = 0;
let pendingSave = Promise.resolve();
const undo = [];
const redo = [];
const messages = {pen: '在画板上拖动绘制', region: '从区域的一角拖到对角', arrow: '从箭尾拖到受力位置',
  text: '点击画布输入文字', select: '拖动对象移动，双击编辑'};

function setTool(next) {
  if (inlineText) finishText();
  tool = next;
  board.dataset.tool = next;
  for (const button of document.querySelectorAll('[data-tool]:not(svg)')) {
    button.setAttribute('aria-pressed', String(button.dataset.tool === next));
  }
  $('#hint').textContent = messages[next];
}

function swatch(color) {
  const dot = document.createElement('span');
  dot.className = 'swatch';
  dot.style.setProperty('--swatch', color);
  dot.setAttribute('aria-hidden', 'true');
  return dot;
}

function chooseBrush(next) {
  brush = next;
  for (const button of presets.children) {
    button.setAttribute('aria-pressed', String(button.dataset.brush === brush));
  }
  customBrush.dataset.selected = String(brush === 'custom');
  customBrush.style.setProperty('--custom-fill', brush === 'custom' ? customColor.value : '#fff');
  brushLabel.textContent = brush === 'custom' ? `自定义 ${customColor.value.toUpperCase()}` :
    (markKinds[brush]?.label ?? '自动');
}

for (const [kind, style] of [['auto', {label: '自动'}], ...Object.entries(markKinds)]) {
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.brush = kind;
  button.className = 'color-well';
  button.setAttribute('aria-label', style.label);
  button.title = style.label;
  if (style.color) button.append(swatch(style.color));
  else {
    const automatic = swatch('#fff');
    automatic.classList.add('auto-swatch');
    button.append(automatic);
  }
  const name = document.createElement('span');
  name.className = 'color-name';
  name.textContent = style.label;
  button.append(name);
  button.addEventListener('click', () => chooseBrush(kind));
  presets.append(button);
  if (kind !== 'auto') editForm.elements.kind.add(new Option(style.label, kind));
}
customColor.addEventListener('input', () => chooseBrush('custom'));
chooseBrush('auto');

function startMark(shape, geometry) {
  const defaultKind = shape === 'arrow' ? 'force' : 'note';
  const kind = Object.hasOwn(markKinds, brush) ? brush : defaultKind;
  return newMark(shape, {...geometry, kind, layerId: activeLayerId, ...(brush === 'custom' ? {color: customColor.value} : {})});
}

function renderLegend() {
  const legend = markLegend(project.marks);
  $('#legend').hidden = !legend.length;
  $('#legend-items').replaceChildren(...legend.map(({color, labels}) => {
    const item = document.createElement('li');
    item.dataset.color = color;
    item.append(swatch(color), labels.join(' / '));
    return item;
  }));
}

function paintBoard() {
  let state = project;
  if (drawing?.mode === 'move' && drawing.moved) {
    state = {...state, marks: state.marks.map(mark => mark.id === drawing.original.id ? drawing.mark : mark)};
  }
  if (opacityPreview) {
    state = {...state, layers: state.layers.map(layer => layer.id === opacityPreview.id ? {...layer, opacity: opacityPreview.value} : layer)};
  }
  const temporary = drawing?.mode === 'move' ? null : drawing?.mark ?? null;
  drawBoard(board, state, temporary, selection);
  // The grid is GPU rendered; SVG composites each whole layer with its opacity.
  paintGpu?.({...state, reference: null, marks: []}, null, null);
}

function renderLayers() {
  const selected = project.marks.find(mark => mark.id === selection);
  const actions = $('#selection-actions');
  actions.hidden = !selected;
  if (selected) {
    const select = $('#object-layer');
    select.replaceChildren(...project.layers.map(layer => new Option(layer.name, layer.id)));
    select.value = selected.layerId;
  }
  const current = project.layers.find(layer => layer.id === activeLayerId);
  const list = $('#layer-list');
  list.replaceChildren(...project.layers.slice().reverse().map(layer => {
    const row = document.createElement('div');
    row.className = 'layer-row';
    row.dataset.active = String(layer.id === activeLayerId);
    const choose = document.createElement('button');
    choose.type = 'button';
    choose.textContent = layer.id === activeLayerId ? '●' : '○';
    choose.setAttribute('aria-label', `选择${layer.name}`);
    choose.onclick = () => { activeLayerId = layer.id; opacityPreview = null; render(); };
    const name = document.createElement('input');
    name.value = layer.name;
    name.maxLength = 40;
    name.setAttribute('aria-label', '图层名称');
    name.addEventListener('focus', () => {
      if (activeLayerId === layer.id) return;
      activeLayerId = layer.id;
      for (const item of list.children) {
        item.dataset.active = String(item === row);
        item.querySelector('button').textContent = item === row ? '●' : '○';
      }
      const index = project.layers.findIndex(item => item.id === layer.id);
      $('#layer-up').disabled = index === project.layers.length - 1;
      $('#layer-down').disabled = index === 0;
      $('#layer-opacity').value = Math.round((layer.opacity ?? 1) * 100);
      $('#opacity-value').value = `${$('#layer-opacity').value}%`;
    });
    name.addEventListener('change', () => {
      const value = name.value.trim() || layer.name;
      if (value !== layer.name) commit({...project, layers: project.layers.map(item => item.id === layer.id ? {...item, name: value} : item)});
      else render();
    });
    const count = document.createElement('small');
    count.textContent = String(project.marks.filter(mark => mark.layerId === layer.id).length + Number(Boolean(project.reference) && project.referenceLayerId === layer.id));
    row.append(choose, name, count);
    return row;
  }));
  const index = project.layers.findIndex(layer => layer.id === activeLayerId);
  $('#layer-up').disabled = index === project.layers.length - 1;
  $('#layer-down').disabled = index <= 0;
  $('#delete-layer').disabled = project.layers.length <= 1;
  const percent = Math.round((current?.opacity ?? 1) * 100);
  $('#layer-opacity').value = percent;
  $('#opacity-value').value = `${percent}%`;
}

function render() {
  paintBoard();
  renderLegend();
  renderLayers();
  $('#undo').disabled = !undo.length;
  $('#redo').disabled = !redo.length;
  const cards = project.marks.filter(mark => mark.shape !== 'pen' || mark.label || mark.value !== null ||
    mark.direction || mark.question || mark.confirmed);
  $('#annotation-count').textContent = cards.length;
  annotations.replaceChildren(...cards.map(mark => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'card';
    button.dataset.selected = String(selection === mark.id);
    const heading = document.createElement('strong');
    heading.textContent = mark.label || markKinds[mark.kind].label;
    heading.prepend(swatch(markColor(mark)));
    const details = document.createElement('small');
    details.textContent = [markKinds[mark.kind].label, mark.value === null ? '' : `${mark.value} ${mark.unit}`.trim(),
      mark.direction, mark.source === 'ai' ? 'AI 建议' : '', mark.confirmed ? '已确认' : ''].filter(Boolean).join(' · ');
    button.append(heading, details);
    if (mark.question && !mark.confirmed) {
      const question = document.createElement('small');
      question.className = 'issue';
      question.textContent = mark.question;
      button.append(question);
    }
    button.addEventListener('click', () => mark.shape === 'text' ? beginText(mark) : openEdit(mark));
    return button;
  }));
  if (!cards.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = '在画板上圈出区域、加箭头或写文字。';
    annotations.append(empty);
  }
}

function apply(next) {
  project = normalizeProject(next);
  if (!project.layers.some(layer => layer.id === activeLayerId)) activeLayerId = project.layers.at(-1).id;
  const projectSnapshot = project;
  const current = ++revision;
  status.dataset.state = 'saving';
  status.textContent = '正在保存到此设备…';
  render();
  pendingSave = pendingSave.then(() => saveProject(projectSnapshot)).then(() => {
    if (revision !== current) return;
    status.dataset.state = 'saved';
    status.textContent = '草稿已保存在此设备';
  }).catch(() => {
    if (revision === current) status.textContent = '草稿保存失败，请导出以保留修改';
  });
}

function commit(next) {
  undo.push(project);
  if (undo.length > 35) undo.shift();
  redo.length = 0;
  apply(next);
}

function undoChange() {
  if (!undo.length) return;
  redo.push(project);
  selection = null;
  apply(undo.pop());
}

function redoChange() {
  if (!redo.length) return;
  undo.push(project);
  selection = null;
  apply(redo.pop());
}

function openEdit(mark) {
  selection = mark.id;
  activeLayerId = mark.layerId;
  editMark = mark;
  render();
  for (const name of ['label', 'kind', 'value', 'unit', 'direction', 'question']) {
    editForm.elements[name].value = mark[name] ?? '';
  }
  editForm.elements.confirmed.checked = mark.confirmed;
  editForm.elements.customColor.checked = Boolean(mark.color);
  editForm.elements.color.value = markColor(mark);
  editForm.elements.color.disabled = !editForm.elements.customColor.checked;
  $('#delete-mark').hidden = !project.marks.some(existing => existing.id === mark.id);
  editDialog.showModal();
  editForm.elements.label.focus();
}

function addMark(mark) {
  selection = mark.id;
  commit({...project, marks: [...project.marks, mark]});
}

function positionText() {
  if (!inlineText) return;
  const point = new DOMPoint(...inlineText.mark.a).matrixTransform(board.getScreenCTM());
  const wrap = board.parentElement.getBoundingClientRect();
  const scale = board.getScreenCTM().a;
  textInput.style.left = `${point.x - wrap.left}px`;
  textInput.style.top = `${point.y - wrap.top}px`;
  textInput.style.fontSize = `${22 * scale}px`;
  textInput.style.color = markColor(inlineText.mark);
  textInput.style.width = `${Math.max(80, Math.min(wrap.right - point.x - 12, 450))}px`;
}

function beginText(mark) {
  if (inlineText) finishText();
  const existing = project.marks.some(item => item.id === mark.id);
  inlineText = {mark, existing};
  selection = mark.id;
  activeLayerId = mark.layerId;
  // Hide the saved text while editing to leave a single caret and text layer.
  drawing = {mark: null};
  paintBoard();
  board.querySelector(`[data-id="${mark.id}"]`)?.setAttribute('visibility', 'hidden');
  textInput.value = mark.label;
  textInput.hidden = false;
  positionText();
  textInput.focus();
  if (existing) textInput.select();
}

function finishText(cancel = false) {
  if (!inlineText) return;
  const {mark, existing} = inlineText;
  board.querySelector(`[data-id="${mark.id}"]`)?.removeAttribute('visibility');
  const label = textInput.value.trim();
  inlineText = null;
  drawing = null;
  textInput.hidden = true;
  if (!cancel && !label && existing) {
    selection = null;
    commit({...project, marks: project.marks.filter(item => item.id !== mark.id)});
  } else if (!cancel && label && label !== mark.label) {
    const updated = {...mark, label};
    if (existing) commit({...project, marks: project.marks.map(item => item.id === mark.id ? updated : item)});
    else addMark(updated);
  } else {
    if (!existing) selection = null;
    render();
  }
}

textInput.addEventListener('blur', () => finishText());
textInput.addEventListener('keydown', event => {
  if (event.isComposing) return;
  if (event.key === 'Enter') { event.preventDefault(); finishText(); }
  if (event.key === 'Escape') { event.preventDefault(); finishText(true); }
});

const resizeBoard = () => {
  const {width, height} = board.getBoundingClientRect();
  if (!width || !height) return;
  // Keep marks made near the edges visible when the window changes shape.
  let halfWidth = 480;
  let halfHeight = 300;
  for (const mark of project?.marks ?? []) {
    for (const point of [mark.a, mark.b, ...(mark.points ?? [])].filter(Boolean)) {
      halfWidth = Math.max(halfWidth, Math.abs(point[0] - 480) + 24);
      halfHeight = Math.max(halfHeight, Math.abs(point[1] - 300) + 24);
    }
  }
  const viewWidth = Math.max(halfWidth * 2, halfHeight * 2 * width / height);
  const viewHeight = Math.max(halfHeight * 2, halfWidth * 2 * height / width);
  board.setAttribute('viewBox', `${(960 - viewWidth) / 2} ${(600 - viewHeight) / 2} ${viewWidth} ${viewHeight}`);
  positionText();
  if (project) paintBoard();
};
new ResizeObserver(resizeBoard).observe(board);

function translatedMark(mark, dx, dy) {
  const move = point => [point[0] + dx, point[1] + dy];
  return {...mark, ...(mark.a ? {a: move(mark.a)} : {}), ...(mark.b ? {b: move(mark.b)} : {}),
    ...(mark.points ? {points: mark.points.map(move)} : {})};
}

board.addEventListener('pointerdown', event => {
  if (!project || drawing || !event.isPrimary || event.button !== 0) return;
  const point = boardPoint(board, event);
  if (tool === 'select') {
    const group = event.target.closest('[data-id]');
    const mark = project.marks.find(item => item.id === group?.dataset.id);
    if (!mark) { selection = null; render(); return; }
    event.preventDefault();
    selection = mark.id;
    activeLayerId = mark.layerId;
    board.setPointerCapture(event.pointerId);
    drawing = {mode: 'move', id: event.pointerId, original: mark, mark, start: point, client: [event.clientX, event.clientY], moved: false};
    render();
    return;
  }
  if (tool === 'text') {
    const group = event.target.closest('[data-id]');
    const mark = project.marks.find(item => item.id === group?.dataset.id && item.shape === 'text');
    event.preventDefault();
    beginText(mark || startMark('text', {a: point}));
    return;
  }
  board.setPointerCapture(event.pointerId);
  drawing = {id: event.pointerId, mark: startMark(tool, tool === 'pen' ? {points: [point]} : {a: point, b: point})};
  paintBoard();
});

board.addEventListener('dblclick', event => {
  if (tool !== 'select') return;
  const group = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-id]');
  const mark = project.marks.find(item => item.id === group?.dataset.id);
  if (!mark) return;
  if (mark.shape === 'text') beginText(mark);
  else openEdit(mark);
});

function extendStroke(event) {
  const mark = drawing.mark;
  const samples = event.getCoalescedEvents?.();
  for (const sample of samples?.length ? samples : [event]) {
    const point = boardPoint(board, sample);
    if (mark.shape !== 'pen') mark.b = point;
    else {
      const last = mark.points.at(-1);
      if (Math.hypot(last[0] - point[0], last[1] - point[1]) >= 2) mark.points.push(point);
    }
  }
}

board.addEventListener('pointermove', event => {
  if (drawing?.id !== event.pointerId) return;
  if (drawing.mode === 'move') {
    if (Math.hypot(event.clientX - drawing.client[0], event.clientY - drawing.client[1]) < 3 && !drawing.moved) return;
    const point = boardPoint(board, event);
    drawing.moved = true;
    drawing.mark = translatedMark(drawing.original, point[0] - drawing.start[0], point[1] - drawing.start[1]);
  } else extendStroke(event);
  paintBoard();
});

board.addEventListener('pointerup', event => {
  if (drawing?.id !== event.pointerId) return;
  if (drawing.mode === 'move') {
    const {original, mark, moved} = drawing;
    drawing = null;
    if (moved) commit({...project, marks: project.marks.map(item => item.id === original.id ? mark : item)});
    else render();
    return;
  }
  extendStroke(event);
  const {mark} = drawing;
  drawing = null;
  if (mark.shape === 'pen' || Math.hypot(mark.b[0] - mark.a[0], mark.b[1] - mark.a[1]) >= 4) addMark(mark);
  else render();
});

for (const type of ['pointercancel', 'lostpointercapture']) {
  board.addEventListener(type, event => {
    if (drawing?.id !== event.pointerId) return;
    drawing = null;
    render();
  });
}

editForm.addEventListener('submit', event => {
  event.preventDefault();
  const data = new FormData(editForm);
  if (editMark.shape === 'text' && !data.get('label').trim() && data.get('value') === '') {
    editForm.elements.label.setCustomValidity('请输入文字或数值。');
    editForm.elements.label.reportValidity();
    return;
  }
  const mark = {...editMark, kind: data.get('kind'), label: data.get('label').trim(),
    value: data.get('value') === '' ? null : Number(data.get('value')), unit: data.get('unit').trim(),
    direction: data.get('direction').trim(), question: data.get('question').trim(), confirmed: data.has('confirmed')};
  if (data.has('customColor')) mark.color = data.get('color');
  else delete mark.color;
  if (project.marks.some(existing => existing.id === mark.id)) {
    commit({...project, marks: project.marks.map(existing => existing.id === mark.id ? mark : existing)});
  } else addMark(mark);
  editDialog.close();
});

function syncEditColor() {
  const fields = editForm.elements;
  fields.color.disabled = !fields.customColor.checked;
  if (fields.color.disabled) fields.color.value = markKinds[fields.kind.value].color;
}
editForm.elements.kind.addEventListener('change', syncEditColor);
editForm.elements.customColor.addEventListener('change', syncEditColor);

editForm.elements.label.addEventListener('input', () => editForm.elements.label.setCustomValidity(''));
editForm.elements.value.addEventListener('input', () => editForm.elements.label.setCustomValidity(''));
editDialog.addEventListener('close', () => editForm.elements.label.setCustomValidity(''));

$('#delete-mark').onclick = () => {
  selection = null;
  commit({...project, marks: project.marks.filter(mark => mark.id !== editMark.id)});
  editDialog.close();
};

for (const button of document.querySelectorAll('[data-close]')) button.onclick = () => button.closest('dialog').close();
for (const button of document.querySelectorAll('button[data-tool]')) button.onclick = () => setTool(button.dataset.tool);
for (const menu of document.querySelectorAll('.menu')) {
  const summary = menu.querySelector('summary');
  menu.addEventListener('click', event => {
    if (event.target.closest('button')) {
      menu.open = false;
      if (!document.querySelector('dialog[open]')) summary.focus();
    }
  });
  menu.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !menu.open) return;
    menu.open = false;
    summary.focus();
  });
  document.addEventListener('pointerdown', event => {
    if (menu.open && !menu.contains(event.target)) menu.open = false;
  });
}
$('#install-dialog').addEventListener('close', () => $('.top-left summary').focus());
$('#toggle-layers').onclick = () => {
  const panel = $('#layers-panel');
  panel.hidden = !panel.hidden;
  $('#toggle-layers').setAttribute('aria-expanded', String(!panel.hidden));
  if (!panel.hidden) { $('#inspector').hidden = true; $('#toggle-inspector').setAttribute('aria-expanded', 'false'); }
};
$('#close-layers').onclick = () => { $('#layers-panel').hidden = true; $('#toggle-layers').setAttribute('aria-expanded', 'false'); };
$('#add-layer').onclick = () => {
  let number = 1;
  while (project.layers.some(layer => layer.name === `图层 ${number}`)) number++;
  const layer = newLayer(`图层 ${number}`);
  activeLayerId = layer.id;
  commit({...project, layers: [...project.layers, layer]});
};
function reorderLayer(direction) {
  const layers = [...project.layers];
  const from = layers.findIndex(layer => layer.id === activeLayerId);
  const to = from + direction;
  if (to < 0 || to >= layers.length) return;
  [layers[from], layers[to]] = [layers[to], layers[from]];
  commit({...project, layers});
}
$('#layer-up').onclick = () => reorderLayer(1);
$('#layer-down').onclick = () => reorderLayer(-1);
$('#delete-layer').onclick = () => {
  if (project.layers.length <= 1) return;
  const index = project.layers.findIndex(layer => layer.id === activeLayerId);
  const removed = activeLayerId;
  const target = project.layers[index - 1] ?? project.layers[index + 1];
  activeLayerId = target.id;
  commit({...project, layers: project.layers.filter(layer => layer.id !== removed),
    referenceLayerId: project.referenceLayerId === removed ? target.id : project.referenceLayerId,
    marks: project.marks.map(mark => mark.layerId === removed ? {...mark, layerId: target.id} : mark)});
};
$('#layer-opacity').addEventListener('input', event => {
  opacityPreview = {id: activeLayerId, value: Number(event.target.value) / 100};
  $('#opacity-value').value = `${event.target.value}%`;
  paintBoard();
});
$('#layer-opacity').addEventListener('change', () => {
  if (!opacityPreview) return;
  const {id, value} = opacityPreview;
  opacityPreview = null;
  if ((project.layers.find(layer => layer.id === id)?.opacity ?? 1) !== value) {
    commit({...project, layers: project.layers.map(layer => layer.id === id ? {...layer, opacity: value} : layer)});
  } else render();
});
$('#object-layer').onchange = event => {
  const id = event.target.value;
  activeLayerId = id;
  commit({...project, marks: project.marks.map(mark => mark.id === selection ? {...mark, layerId: id} : mark)});
};
$('#edit-selected').onclick = () => {
  const mark = project.marks.find(item => item.id === selection);
  if (!mark) return;
  if (mark.shape === 'text') beginText(mark);
  else openEdit(mark);
};
$('#delete-selected').onclick = () => {
  const id = selection;
  if (!id) return;
  selection = null;
  commit({...project, marks: project.marks.filter(mark => mark.id !== id)});
};

$('#toggle-inspector').onclick = () => {
  const panel = $('#inspector');
  panel.hidden = !panel.hidden;
  $('#toggle-inspector').setAttribute('aria-expanded', String(!panel.hidden));
  if (!panel.hidden) { $('#layers-panel').hidden = true; $('#toggle-layers').setAttribute('aria-expanded', 'false'); }
};
$('#close-inspector').onclick = () => { $('#inspector').hidden = true; $('#toggle-inspector').setAttribute('aria-expanded', 'false'); };
$('#undo').onclick = undoChange;
$('#redo').onclick = redoChange;
document.addEventListener('keydown', event => {
  if (!project || inlineText || document.querySelector('dialog[open]') || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'z') return;
  event.preventDefault();
  if (event.shiftKey) redoChange();
  else undoChange();
});

function replaceCanvas(next) {
  selection = null;
  notice.textContent = '';
  commit(next);
}

$('#demo').onclick = () => replaceCanvas(demoProject());
$('#new').onclick = () => replaceCanvas(emptyProject());
$('#import').onclick = () => $('#image-file').click();
$('#image-file').onchange = async event => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  const start = revision;
  try {
    const reference = await readReference(file);
    if (start !== revision) {
      notice.textContent = '导入时草图已更新，请重新选择图片。';
      return;
    }
    replaceCanvas({...emptyProject(), reference});
  } catch {
    notice.textContent = '无法打开该图片，请选择可预览的 PNG、JPEG 或 WebP。';
  }
};

function download(url, filename) {
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
}

function snapshot(state = project) {
  const copy = board.cloneNode(false);
  drawBoard(copy, state);
  return copy;
}

$('#copy-image').onclick = async () => {
  if (!navigator.clipboard?.write || !window.ClipboardItem) {
    notice.textContent = '当前浏览器不支持复制图片，请使用「文件 → 导出 PNG」。';
    return;
  }
  try {
    const image = bitmap(snapshot()).then(data => fetch(data)).then(response => response.blob());
    await navigator.clipboard.write([new ClipboardItem({'image/png': image})]);
    notice.textContent = '画布图片已复制到剪贴板。';
  } catch {
    notice.textContent = '复制图片失败，请检查浏览器的剪贴板权限，或使用「文件 → 导出 PNG」。';
  }
};

$('#export-png').onclick = async () => {
  try {
    download(await bitmap(snapshot()), 'sim-sketch.png');
  } catch {
    notice.textContent = 'PNG 导出失败。';
  }
};
$('#export-json').onclick = () => {
  const view = board.viewBox.baseVal;
  const output = {version: 1, coordinateSystem: 'image-pixels', width: 960, height: 600, viewBox: [view.x, view.y, view.width, view.height], ...project,
    legend: markLegend(project.marks), marks: project.marks.map(mark => ({...mark, color: markColor(mark)}))};
  const url = URL.createObjectURL(new Blob([JSON.stringify(output, null, 2)], {type: 'application/json'}));
  download(url, 'sim-sketch.json');
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

let installPrompt;
window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  installPrompt = event;
});
if (matchMedia('(display-mode: standalone)').matches || navigator.standalone) $('#install').hidden = true;
window.addEventListener('appinstalled', () => { $('#install').hidden = true; });
$('#install').onclick = async () => {
  if (!installPrompt) $('#install-dialog').showModal();
  else {
    const prompt = installPrompt;
    installPrompt = null;
    await prompt.prompt();
  }
};

function showRenderer(mode) {
  const active = mode === 'WebGPU';
  board.parentElement.dataset.gpu = String(active);
}

async function startRenderer() {
  showRenderer('WebGPU 准备中');
  try {
    paintGpu = await createGpuBoard($('#gpu-board'), showRenderer);
    if (paintGpu) paintBoard();
    else showRenderer('SVG 兼容模式');
  } catch (error) {
    showRenderer('SVG 兼容模式');
    console.warn('WebGPU 初始化失败。', error);
  }
}

async function start() {
  try {
    const draft = await readProject();
    if (draft) {
      project = normalizeProject(draft);
      activeLayerId = project.layers.at(-1).id;
      status.dataset.state = 'saved';
      status.textContent = '草稿已保存在此设备';
      render();
    } else apply(demoProject());
  } catch {
    project = normalizeProject(demoProject());
    activeLayerId = project.layers.at(-1).id;
    status.textContent = '此浏览器无法保存草稿，可以导出';
    render();
  }
  setTool(tool);
  $('main').inert = false;
  resizeBoard();
  void startRenderer();

  if (!('serviceWorker' in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.register('./sw.js', {updateViaCache: 'none'});
    const offerUpdate = () => {
      if (!registration.waiting || !navigator.serviceWorker.controller || $('#update')) return;
      const button = document.createElement('button');
      button.id = 'update';
      button.textContent = '更新';
      button.onclick = async () => {
        await pendingSave;
        navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), {once: true});
        registration.waiting?.postMessage('activate-update');
      };
      $('.top-left').append(button);
    };
    offerUpdate();
    registration.addEventListener('updatefound', () => registration.installing?.addEventListener('statechange', offerUpdate));
  } catch {
    $('#hint').textContent = '离线缓存设置失败，当前可在线绘制';
  }
}

await start();
