import {bitmap, boardPoint, drawBoard, readReference} from './board.js';
import {demoProject, emptyProject, markColor, markKinds, markLegend, newMark, readProject, saveProject} from './project.js';
import {createGpuBoard} from './gpu-board.js';
import {interpretSketch} from './vision.js';

const $ = selector => document.querySelector(selector);
const board = $('#board');
const status = $('#status');
const rendererStatus = $('#renderer');
const annotations = $('#annotations');
const analysisStatus = $('#analysis-status');
const editDialog = $('#edit-dialog');
const editForm = $('#edit-form');
const settingsDialog = $('#settings-dialog');
const settingsForm = $('#settings-form');
const analyze = $('#analyze');
const presets = $('#preset-colors');
const customColor = $('#custom-color');
const customBrush = customColor.closest('label');
const brushLabel = $('#brush-label');

let project;
let paintGpu;
let selection = null;
let drawing = null;
let editMark = null;
let tool = 'pen';
let brush = 'auto';
let revision = 0;
let pendingSave = Promise.resolve();
const undo = [];
const redo = [];
let modelSettings = {endpoint: '', model: '', key: ''};

try {
  const saved = JSON.parse(localStorage.getItem('sim-sketch:model') || '{}');
  modelSettings = {endpoint: saved.endpoint || '', model: saved.model || '', key: ''};
} catch {
  // Drawing remains available with browser storage disabled.
}

const messages = {pen: '在画板上拖动绘制', region: '从区域的一角拖到对角', arrow: '从箭尾拖到受力位置',
  text: '轻点画板放置文字', select: '轻点画板或右侧列表中的标注进行编辑'};

function setTool(next) {
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
  button.addEventListener('click', () => chooseBrush(kind));
  presets.append(button);
  if (kind !== 'auto') editForm.elements.kind.add(new Option(style.label, kind));
}
customColor.addEventListener('input', () => chooseBrush('custom'));
chooseBrush('auto');

function startMark(shape, geometry) {
  const defaultKind = shape === 'arrow' ? 'force' : 'note';
  const kind = Object.hasOwn(markKinds, brush) ? brush : defaultKind;
  return newMark(shape, {...geometry, kind, ...(brush === 'custom' ? {color: customColor.value} : {})});
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
  const temporary = drawing?.mark ?? null;
  drawBoard(board, project, temporary, selection);
  paintGpu?.(project, temporary, selection);
}

function render() {
  paintBoard();
  renderLegend();
  $('#undo').disabled = !undo.length;
  $('#redo').disabled = !redo.length;
  const cards = project.marks.filter(mark => mark.shape !== 'pen' || mark.label || mark.value !== null ||
    mark.direction || mark.question || mark.confirmed);
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
    button.addEventListener('click', () => openEdit(mark));
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
  project = next;
  const current = ++revision;
  status.dataset.state = 'saving';
  status.textContent = '正在保存到此设备…';
  render();
  pendingSave = pendingSave.then(() => saveProject(next)).then(() => {
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

board.addEventListener('pointerdown', event => {
  if (!project || drawing || !event.isPrimary || event.button !== 0) return;
  const point = boardPoint(board, event);
  if (tool === 'select') {
    const group = event.target.closest('[data-id]');
    const mark = project.marks.find(item => item.id === group?.dataset.id);
    if (mark) openEdit(mark);
    else {
      selection = null;
      render();
    }
    return;
  }
  if (tool === 'text') {
    openEdit(startMark('text', {a: point}));
    return;
  }
  board.setPointerCapture(event.pointerId);
  drawing = {id: event.pointerId, mark: startMark(tool, tool === 'pen' ? {points: [point]} : {a: point, b: point})};
  paintBoard();
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
  extendStroke(event);
  paintBoard();
});

board.addEventListener('pointerup', event => {
  if (drawing?.id !== event.pointerId) return;
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
for (const dialog of [settingsDialog, $('#install-dialog')]) {
  dialog.addEventListener('close', () => $('.header-actions summary').focus());
}
$('#undo').onclick = undoChange;
$('#redo').onclick = redoChange;
document.addEventListener('keydown', event => {
  if (!project || document.querySelector('dialog[open]') || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'z') return;
  event.preventDefault();
  if (event.shiftKey) redoChange();
  else undoChange();
});

function replaceCanvas(next) {
  selection = null;
  analysisStatus.textContent = '';
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
      analysisStatus.textContent = '导入时草图已更新，请重新选择图片。';
      return;
    }
    replaceCanvas({...emptyProject(), reference});
  } catch {
    analysisStatus.textContent = '无法打开该图片，请选择可预览的 PNG、JPEG 或 WebP。';
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

$('#export-png').onclick = async () => {
  try {
    download(await bitmap(snapshot()), 'sim-sketch.png');
  } catch {
    analysisStatus.textContent = 'PNG 导出失败。';
  }
};
$('#export-json').onclick = () => {
  const output = {version: 1, coordinateSystem: 'image-pixels', width: 960, height: 600, ...project,
    legend: markLegend(project.marks), marks: project.marks.map(mark => ({...mark, color: markColor(mark)}))};
  const url = URL.createObjectURL(new Blob([JSON.stringify(output, null, 2)], {type: 'application/json'}));
  download(url, 'sim-sketch.json');
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

function showSettings() {
  for (const name of ['endpoint', 'model', 'key']) settingsForm.elements[name].value = modelSettings[name];
  settingsDialog.showModal();
}

$('#settings').onclick = showSettings;
settingsForm.elements.endpoint.addEventListener('input', () => settingsForm.elements.endpoint.setCustomValidity(''));
settingsForm.onsubmit = event => {
  event.preventDefault();
  const data = new FormData(settingsForm);
  const endpoint = new URL(data.get('endpoint'));
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
  if (endpoint.protocol !== 'https:' && !(loopback && endpoint.protocol === 'http:')) {
    settingsForm.elements.endpoint.setCustomValidity('请输入 HTTPS 接口或本机 HTTP 环回地址。');
    settingsForm.elements.endpoint.reportValidity();
    return;
  }
  modelSettings = {endpoint: endpoint.href, model: data.get('model').trim(), key: data.get('key').trim()};
  try {
    localStorage.setItem('sim-sketch:model', JSON.stringify({endpoint: modelSettings.endpoint, model: modelSettings.model}));
  } catch {
    analysisStatus.textContent = '模型设置将在当前页面使用。';
  }
  settingsDialog.close();
};

analyze.onclick = async () => {
  if (!navigator.onLine) {
    analysisStatus.textContent = '当前离线，恢复连接后可使用 AI。';
    return;
  }
  if (!modelSettings.endpoint || !modelSettings.model) {
    showSettings();
    return;
  }
  const start = revision;
  const input = {...project, marks: project.marks.filter(mark => mark.source !== 'ai' || mark.confirmed)};
  analyze.disabled = true;
  analysisStatus.textContent = '正在分析草图和标注…';
  try {
    const image = await bitmap(snapshot(input), 'image/jpeg');
    const marks = await interpretSketch(modelSettings, image, input.marks);
    if (revision !== start) {
      analysisStatus.textContent = '草图已修改，请重新读图。';
      return;
    }
    selection = marks[0]?.id ?? null;
    if (marks.length || input.marks.length !== project.marks.length) {
      commit({...project, marks: [...input.marks, ...marks]});
    }
    analysisStatus.textContent = marks.length ? `识别到 ${marks.length} 个标注，点击查看和修正。` : '没有识别到新的约束或载荷。';
  } catch (error) {
    analysisStatus.textContent = revision === start ?
      `读图失败。请检查模型地址、密钥和跨域权限。 ${error.message}` : '草图已修改，请重新读图。';
  } finally {
    analyze.disabled = false;
  }
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
  if (rendererStatus.textContent === mode) return;
  board.parentElement.dataset.gpu = String(active);
  rendererStatus.textContent = mode;
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
      project = draft;
      status.dataset.state = 'saved';
      status.textContent = '草稿已保存在此设备';
      render();
    } else apply(demoProject());
  } catch {
    project = demoProject();
    status.textContent = '此浏览器无法保存草稿，可以导出';
    render();
  }
  setTool(tool);
  $('main').inert = false;
  $('.header-actions').inert = false;
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
      $('.project-actions').prepend(button);
    };
    offerUpdate();
    registration.addEventListener('updatefound', () => registration.installing?.addEventListener('statechange', offerUpdate));
  } catch {
    $('#hint').textContent = '离线缓存设置失败，当前可在线绘制';
  }
}

await start();
