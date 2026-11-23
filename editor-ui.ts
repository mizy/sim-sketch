import {canBoolean} from './geometry.ts';
import type {BooleanOperation} from './geometry.ts';
import {withNewLayer, withRemovedLayer, withReorderedLayers} from './layers.ts';
import {markColor, markKinds, markLegend} from './project.ts';
import type {ArrowMark, Mark, MarkKind, TextMark} from './project.ts';
import type {Editor} from './editor.ts';
import {MAX_MARK_WIDTH, MIN_MARK_WIDTH} from './mark-width.ts';
import {clampMarkStyleSize, DEFAULT_ARROW_SIZE, DEFAULT_TEXT_FONT_SIZE,
  normalizeArrowSize} from './mark-style.ts';
import {TOOL_MESSAGES} from './editor-types.ts';
import type {Brush} from './editor-types.ts';
import type {PenCurveKind, PenFitMode} from './pen-fit.ts';
import {SNAP_LABELS} from './snap.ts';
import type {SnapResult} from './snap.ts';

type FormField = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number']);
const SNAP_PREFERENCE_KEY = 'sim-sketch-snap';
const ERASER_WIDTH_KEY = 'sim-sketch-eraser-width';
const PEN_FIT_KEY = 'sim-sketch-pen-fit';
const PEN_CURVE_KEY = 'sim-sketch-pen-curve';
const DEFAULT_ERASER_WIDTH = 12;
const PEN_FIT_MODES = new Set<PenFitMode>(['off', 'line', 'curve']);
const PEN_CURVE_KINDS = new Set<PenCurveKind>(['quadratic', 'cubic']);

function element<T extends Element>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`找不到页面元素：${selector}`);
  return node;
}

function swatch(color: string): HTMLSpanElement {
  const dot = document.createElement('span');
  dot.className = 'swatch';
  dot.style.setProperty('--swatch', color);
  dot.setAttribute('aria-hidden', 'true');
  return dot;
}

export interface EditorUiOptions {
  annotations: HTMLDivElement;
  editDialog: HTMLDialogElement;
  editForm: HTMLFormElement;
  presets: HTMLDivElement;
  customColor: HTMLInputElement;
  customBrush: HTMLLabelElement;
  brushLabel: HTMLElement;
}

/** 编辑器 DOM 投影：图层面板、标注卡片、编辑表单与快捷键，不持有项目状态。 */
export function createEditorUi(editor: Editor, options: EditorUiOptions): void {
  const {annotations, editDialog, editForm, presets, customColor, customBrush, brushLabel} = options;
  const edit = {
    label: editField(editForm, 'label'),
    kind: editField<HTMLSelectElement>(editForm, 'kind'),
    value: editField(editForm, 'value'),
    unit: editField(editForm, 'unit'),
    direction: editField(editForm, 'direction'),
    question: editField(editForm, 'question'),
    confirmed: editField(editForm, 'confirmed'),
    customColor: editField(editForm, 'customColor'),
    color: editField(editForm, 'color'),
    arrowSize: editField<HTMLInputElement>(editForm, 'arrowSize')
  };
  let editMark: Mark | null = null;

  const renderLegend = (): void => {
    const legend = markLegend(editor.project.marks);
    element<HTMLElement>('#legend').hidden = !legend.length;
    element<HTMLUListElement>('#legend-items').replaceChildren(...legend.map(({color, labels}) => {
      const item = document.createElement('li');
      item.dataset.color = color;
      item.append(swatch(color), labels.join(' / '));
      return item;
    }));
  };

  /** 旋转手势期间只读角度；图形与标注各有一个读数节点，按钮/输入项保持不变。 */
  const renderAngle = (): void => {
    const label = editor.transformAngleLabel();
    for (const node of document.querySelectorAll<HTMLElement>('#shape-angle, #selection-angle')) {
      node.hidden = !label;
      if (label) node.textContent = label;
    }
  };

  const renderShapeActions = (): void => {
    const selected = editor.selectedShapes;
    const shapes = editor.project.shapes.filter(shape => selected.includes(shape.id));
    element<HTMLElement>('#shape-actions').hidden = !shapes.length;
    element<HTMLElement>('#shape-count').textContent = `已选 ${shapes.length} 个图形`;
    renderAngle();
    const allowed = canBoolean(shapes);
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-boolean]')) button.disabled = !allowed;
  };

  /**
   * 选中操作条跟着对象走，而不是永远钉在画板顶部。
   * 上边缘放不下时翻到对象下方，左右和底部都夹在视口内，避免手机边缘被裁掉。
   */
  const placeActions = (actions: HTMLElement, bounds: DOMRect, reservedTopPx = 0): void => {
    const gap = 10;
    const edge = 8;
    const minTop = 76;
    const width = actions.offsetWidth;
    const height = actions.offsetHeight;
    let left = bounds.left + bounds.width / 2 - width / 2;
    left = Math.max(edge, Math.min(window.innerWidth - width - edge, left));
    // 上方还要放旋转手柄：放得下才整体让位，放不下时优先保持“操作条在对象上方”。
    let top = bounds.top - height - gap;
    if (top - reservedTopPx >= minTop) top -= reservedTopPx;
    if (top < minTop) top = bounds.bottom + gap;
    top = Math.max(edge, Math.min(window.innerHeight - height - edge, top));
    actions.style.left = `${Math.round(left)}px`;
    actions.style.top = `${Math.round(top)}px`;
    actions.style.transform = 'none';
  };

  const unionBounds = (nodes: Element[]): DOMRect | null => {
    if (!nodes.length) return null;
    const rects = nodes.map(node => node.getBoundingClientRect());
    const left = Math.min(...rects.map(rect => rect.left));
    const top = Math.min(...rects.map(rect => rect.top));
    const right = Math.max(...rects.map(rect => rect.right));
    const bottom = Math.max(...rects.map(rect => rect.bottom));
    return new DOMRect(left, top, right - left, bottom - top);
  };

  const positionActions = (): void => {
    const selectionActions = element<HTMLElement>('#selection-actions');
    if (!selectionActions.hidden && editor.selection) {
      const node = document.querySelector(`#board [data-id="${CSS.escape(editor.selection)}"]`);
      const bounds = node?.getBoundingClientRect();
      if (bounds?.width || bounds?.height) placeActions(selectionActions, bounds, 30);
    }
    const shapeActions = element<HTMLElement>('#shape-actions');
    if (!shapeActions.hidden && editor.selectedShapes.length) {
      const nodes = editor.selectedShapes.flatMap(id =>
        Array.from(document.querySelectorAll(`#board [data-shape-id="${CSS.escape(id)}"]`)));
      const bounds = unionBounds(nodes);
      if (bounds) placeActions(shapeActions, bounds, 30);
    }
  };
  let positionFrame = 0;
  const schedulePosition = (): void => {
    // 先同步摆一次，避免选中后一帧内还停在 CSS 默认的顶部位置；
    // 再排一帧，等 viewBox/尺寸变化落定后校正。
    positionActions();
    cancelAnimationFrame(positionFrame);
    positionFrame = requestAnimationFrame(positionActions);
  };
  window.addEventListener('resize', schedulePosition);
  new ResizeObserver(schedulePosition).observe(element<SVGSVGElement>('#board'));
  // 拖动/缩放/旋转预览时只让操作条与角度读数跟随，不重建面板/标注卡片。
  editor.onPreview = () => {
    schedulePosition();
    renderAngle();
  };

  const renderLayers = (): void => {
    const selectedMark = editor.project.marks.find(mark => mark.id === editor.selection);
    const actions = element<HTMLElement>('#selection-actions');
    actions.hidden = !selectedMark;
    if (selectedMark) {
      const select = element<HTMLSelectElement>('#object-layer');
      select.replaceChildren(...editor.project.layers.map(layer => new Option(layer.name, layer.id)));
      select.value = selectedMark.layerId;
    }
    const current = editor.project.layers.find(layer => layer.id === editor.activeLayerId);
    const list = element<HTMLDivElement>('#layer-list');
    list.replaceChildren(...editor.project.layers.slice().reverse().map(layer => {
      const row = document.createElement('div');
      row.className = 'layer-row';
      row.dataset.active = String(layer.id === editor.activeLayerId);
      const choose = document.createElement('button');
      choose.type = 'button';
      choose.textContent = layer.id === editor.activeLayerId ? '●' : '○';
      choose.setAttribute('aria-label', `选择${layer.name}`);
      choose.onclick = () => { editor.activateLayer(layer.id); editor.render(); };
      const name = document.createElement('input');
      name.value = layer.name;
      name.maxLength = 40;
      name.setAttribute('aria-label', '图层名称');
      name.addEventListener('focus', () => {
        if (editor.activeLayerId === layer.id) return;
        editor.activateLayer(layer.id);
        for (const item of list.children) {
          (item as HTMLElement).dataset.active = String(item === row);
          item.querySelector('button')!.textContent = item === row ? '●' : '○';
        }
        const index = editor.project.layers.findIndex(item => item.id === layer.id);
        element<HTMLButtonElement>('#layer-up').disabled = index === editor.project.layers.length - 1;
        element<HTMLButtonElement>('#layer-down').disabled = index === 0;
        element<HTMLInputElement>('#layer-opacity').value = String(Math.round((layer.opacity ?? 1) * 100));
        element<HTMLOutputElement>('#opacity-value').value = `${element<HTMLInputElement>('#layer-opacity').value}%`;
      });
      name.addEventListener('change', () => {
        const value = name.value.trim() || layer.name;
        if (value !== layer.name) {
          editor.commit({...editor.project, layers: editor.project.layers.map(item =>
            item.id === layer.id ? {...item, name: value} : item)});
        } else editor.render();
      });
      const count = document.createElement('small');
      count.textContent = String(editor.project.marks.filter(mark => mark.layerId === layer.id).length +
        editor.project.shapes.filter(shape => shape.layerId === layer.id).length +
        Number(Boolean(editor.project.reference) && editor.project.referenceLayerId === layer.id));
      row.append(choose, name, count);
      return row;
    }));
    const index = editor.project.layers.findIndex(layer => layer.id === editor.activeLayerId);
    element<HTMLButtonElement>('#layer-up').disabled = index === editor.project.layers.length - 1;
    element<HTMLButtonElement>('#layer-down').disabled = index <= 0;
    element<HTMLButtonElement>('#delete-layer').disabled = editor.project.layers.length <= 1;
    const percent = Math.round((current?.opacity ?? 1) * 100);
    element<HTMLInputElement>('#layer-opacity').value = String(percent);
    element<HTMLOutputElement>('#opacity-value').value = `${percent}%`;
  };

  const renderAnnotations = (): void => {
    const cards = editor.project.marks.filter(mark => mark.shape !== 'pen' || mark.label || mark.value !== null ||
      mark.direction || mark.question || mark.confirmed);
    element<HTMLElement>('#annotation-count').textContent = String(cards.length);
    annotations.replaceChildren(...cards.map(mark => {
      const kind = markKinds[mark.kind] ?? markKinds.note;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'card';
      button.dataset.selected = String(editor.selection === mark.id);
      const heading = document.createElement('strong');
      heading.textContent = mark.label || kind.label;
      heading.prepend(swatch(markColor(mark)));
      const details = document.createElement('small');
      details.textContent = [kind.label, mark.value === null ? '' : `${mark.value} ${mark.unit}`.trim(),
        mark.direction, mark.source === 'ai' ? 'AI 建议' : '', mark.confirmed ? '已确认' : ''].filter(Boolean).join(' · ');
      button.append(heading, details);
      if (mark.question && !mark.confirmed) {
        const question = document.createElement('small');
        question.className = 'issue';
        question.textContent = mark.question;
        button.append(question);
      }
      button.addEventListener('click', () => mark.shape === 'text' ? editor.beginText(mark) : openEdit(mark));
      return button;
    }));
    if (!cards.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = '在画板上圈出区域、加箭头或写文字。';
      annotations.append(empty);
    }
  };

  const render = (): void => {
    renderLegend();
    renderLayers();
    renderShapeActions();
    renderAnnotations();
    syncMarkStyleControls();
    element<HTMLButtonElement>('#undo').disabled = !editor.canUndo;
    element<HTMLButtonElement>('#redo').disabled = !editor.canRedo;
    schedulePosition();
  };

  const openEdit = (mark: Mark): void => {
    editor.focusMark(mark);
    editMark = mark;
    edit.label.value = mark.label;
    edit.kind.value = mark.kind;
    edit.value.value = mark.value === null ? '' : String(mark.value);
    edit.unit.value = mark.unit;
    edit.direction.value = mark.direction;
    edit.question.value = mark.question;
    edit.confirmed.checked = mark.confirmed;
    const arrowRow = element<HTMLElement>('#edit-arrow-size-row');
    arrowRow.hidden = mark.shape !== 'arrow';
    if (mark.shape === 'arrow') {
      edit.arrowSize.value = String(clampMarkStyleSize(mark.size) ?? DEFAULT_ARROW_SIZE);
    }
    edit.customColor.checked = Boolean(mark.color);
    edit.color.value = markColor(mark);
    edit.color.disabled = !edit.customColor.checked;
    element<HTMLButtonElement>('#delete-mark').hidden = !editor.project.marks.some(existing => existing.id === mark.id);
    editDialog.showModal();
    edit.label.focus();
  };
  editor.onOpenMark = openEdit;

  function chooseBrush(next: Brush): void {
    editor.setBrush(next, customColor.value);
    for (const button of presets.children) {
      button.setAttribute('aria-pressed', String((button as HTMLElement).dataset.brush === next));
    }
    customBrush.dataset.selected = String(next === 'custom');
    customBrush.style.setProperty('--custom-fill', next === 'custom' ? customColor.value : '#fff');
    const kind = Object.hasOwn(markKinds, next) ? next as MarkKind : null;
    brushLabel.textContent = next === 'custom' ? `自定义 ${customColor.value.toUpperCase()}` :
      (kind ? markKinds[kind].label : '自动');
  }

  for (const [kind, style] of [['auto', {label: '自动', color: undefined}], ...Object.entries(markKinds)] as
    [Brush, {label: string; color?: string}][]) {
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
    if (kind !== 'auto') edit.kind.add(new Option(style.label, kind));
  }
  customColor.addEventListener('input', () => chooseBrush('custom'));
  chooseBrush('auto');

  // 粗细状态由 Editor 持有；滑块只负责写入与回显，选择颜色不会重置它。
  const widthInput = element<HTMLInputElement>('#brush-width');
  const widthValue = element<HTMLOutputElement>('#brush-width-value');
  const widthPreview = element<SVGLineElement>('#brush-width-preview');
  // 范围与初值只从 TS 常量来，避免模板属性与代码常量各改一半。
  widthInput.min = String(MIN_MARK_WIDTH);
  widthInput.max = String(MAX_MARK_WIDTH);
  const syncBrushWidth = (): void => {
    const width = editor.brushWidth;
    widthInput.value = String(width);
    widthValue.value = `${width} px`;
    widthPreview.setAttribute('stroke-width', String(width));
  };
  widthInput.addEventListener('input', () => {
    editor.setBrushWidth(Number(widthInput.value));
    syncBrushWidth();
  });
  syncBrushWidth();

  // 箭头大小/字号：新建默认值只影响下一次；选中已有对象时走操作条预览 + change 提交。
  const arrowSizeControl = element<HTMLElement>('#arrow-size-control');
  const arrowSizeInput = element<HTMLInputElement>('#arrow-size');
  const arrowSizeValue = element<HTMLOutputElement>('#arrow-size-value');
  const textSizeControl = element<HTMLElement>('#text-size-control');
  const textSizeInput = element<HTMLInputElement>('#text-font-size');
  const textSizeValue = element<HTMLOutputElement>('#text-font-size-value');
  const selectionArrowControl = element<HTMLElement>('#selection-arrow-size-control');
  const selectionArrowInput = element<HTMLInputElement>('#selection-arrow-size');
  const selectionArrowValue = element<HTMLOutputElement>('#selection-arrow-size-value');
  const selectionTextControl = element<HTMLElement>('#selection-text-size-control');
  const selectionTextInput = element<HTMLInputElement>('#selection-text-font-size');
  const selectionTextValue = element<HTMLOutputElement>('#selection-text-font-size-value');

  function syncMarkStyleControls(): void {
    arrowSizeControl.hidden = editor.tool !== 'arrow';
    textSizeControl.hidden = editor.tool !== 'text';
    arrowSizeInput.value = String(editor.arrowSize);
    arrowSizeValue.value = `${editor.arrowSize} px`;
    textSizeInput.value = String(editor.textFontSize);
    textSizeValue.value = `${editor.textFontSize} px`;
    const mark = editor.selectedMark;
    const arrow = mark?.shape === 'arrow' ? mark : null;
    const text = mark?.shape === 'text' ? mark : null;
    selectionArrowControl.hidden = !arrow;
    selectionTextControl.hidden = !text;
    if (arrow) {
      const size = clampMarkStyleSize(arrow.size) ?? DEFAULT_ARROW_SIZE;
      selectionArrowInput.value = String(size);
      selectionArrowValue.value = `${size} px`;
    }
    if (text) {
      const size = clampMarkStyleSize(text.fontSize) ?? DEFAULT_TEXT_FONT_SIZE;
      selectionTextInput.value = String(size);
      selectionTextValue.value = `${size} px`;
    }
  }

  arrowSizeInput.addEventListener('input', () => {
    editor.setArrowSize(Number(arrowSizeInput.value));
    syncMarkStyleControls();
  });
  textSizeInput.addEventListener('input', () => {
    editor.setTextFontSize(Number(textSizeInput.value));
    syncMarkStyleControls();
  });
  selectionArrowInput.addEventListener('input', () => {
    editor.previewSelectedArrowSize(Number(selectionArrowInput.value));
    selectionArrowValue.value = `${selectionArrowInput.value} px`;
  });
  selectionArrowInput.addEventListener('change', () => editor.commitSelectedMarkStyle());
  selectionTextInput.addEventListener('input', () => {
    editor.previewSelectedTextFontSize(Number(selectionTextInput.value));
    selectionTextValue.value = `${selectionTextInput.value} px`;
  });
  selectionTextInput.addEventListener('change', () => editor.commitSelectedMarkStyle());

  // 橡皮擦尺寸独立记忆：与画笔粗细共用 1–24 范围，但互不覆盖。
  const eraserSize = element<HTMLElement>('#eraser-size');
  const eraserWidthInput = element<HTMLInputElement>('#eraser-width');
  const eraserWidthValue = element<HTMLOutputElement>('#eraser-width-value');
  const eraserCursor = element<HTMLElement>('#eraser-cursor');
  const boardElement = element<SVGSVGElement>('#board');
  eraserWidthInput.min = String(MIN_MARK_WIDTH);
  eraserWidthInput.max = String(MAX_MARK_WIDTH);
  editor.setEraserWidth(readStoredNumber(ERASER_WIDTH_KEY) ?? DEFAULT_ERASER_WIDTH);
  const syncEraserWidth = (): void => {
    const width = editor.eraserWidth;
    eraserWidthInput.value = String(width);
    eraserWidthValue.value = `${width} px`;
    eraserCursor.style.width = `${width}px`;
    eraserCursor.style.height = `${width}px`;
  };
  eraserWidthInput.addEventListener('input', () => {
    editor.setEraserWidth(Number(eraserWidthInput.value));
    writePreference(ERASER_WIDTH_KEY, String(editor.eraserWidth));
    syncEraserWidth();
  });
  syncEraserWidth();

  const positionEraserCursor = (event: PointerEvent): void => {
    if (editor.tool !== 'eraser' || editor.textEditing) return;
    const rect = boardElement.getBoundingClientRect();
    eraserCursor.hidden = false;
    eraserCursor.style.left = `${event.clientX - rect.left}px`;
    eraserCursor.style.top = `${event.clientY - rect.top}px`;
  };
  boardElement.addEventListener('pointermove', positionEraserCursor);
  boardElement.addEventListener('pointerdown', positionEraserCursor);
  boardElement.addEventListener('pointerleave', () => {
    eraserCursor.hidden = true;
  });
  const syncEraserUi = (): void => {
    const active = editor.tool === 'eraser';
    eraserSize.hidden = !active;
    if (!active) eraserCursor.hidden = true;
  };

  // 手绘拟合只影响自由画笔；设置跨刷新保留，与磁吸偏好同为 localStorage 工具设置。
  const fitInput = element<HTMLSelectElement>('#pen-fit');
  const curveInput = element<HTMLSelectElement>('#pen-curve');
  const readPenFit = (): PenFitMode => {
    const value = readPreference(PEN_FIT_KEY);
    return PEN_FIT_MODES.has(value as PenFitMode) ? value as PenFitMode : 'off';
  };
  const readPenCurve = (): PenCurveKind => {
    const value = readPreference(PEN_CURVE_KEY);
    return PEN_CURVE_KINDS.has(value as PenCurveKind) ? value as PenCurveKind : 'cubic';
  };
  const syncPenFit = (): void => {
    fitInput.value = editor.penFit;
    curveInput.value = editor.penCurve;
    // 非曲线模式不展示阶数选择，但保留上次选择供再次切回曲线时使用。
    curveInput.hidden = editor.penFit !== 'curve';
    curveInput.disabled = editor.penFit !== 'curve';
  };
  editor.setPenFit(readPenFit(), readPenCurve());
  syncPenFit();
  fitInput.addEventListener('change', () => {
    editor.setPenFit(fitInput.value as PenFitMode, curveInput.value as PenCurveKind);
    writePreference(PEN_FIT_KEY, editor.penFit);
    syncPenFit();
  });
  curveInput.addEventListener('change', () => {
    editor.setPenFit(fitInput.value as PenFitMode, curveInput.value as PenCurveKind);
    writePreference(PEN_CURVE_KEY, editor.penCurve);
    syncPenFit();
  });

  editForm.addEventListener('submit', event => {
    event.preventDefault();
    if (!editMark) return;
    const data = new FormData(editForm);
    const label = String(data.get('label') ?? '').trim();
    const valueText = String(data.get('value') ?? '');
    if (editMark.shape === 'text' && !label && valueText === '') {
      edit.label.setCustomValidity('请输入文字或数值。');
      edit.label.reportValidity();
      return;
    }
    const mark: Mark = {...editMark, kind: String(data.get('kind')) as MarkKind, label,
      value: valueText === '' ? null : Number(valueText), unit: String(data.get('unit') ?? '').trim(),
      direction: String(data.get('direction') ?? '').trim(), question: String(data.get('question') ?? '').trim(),
      confirmed: data.has('confirmed')};
    if (editMark.shape === 'arrow') {
      const sizeText = String(data.get('arrowSize') ?? '').trim();
      if (sizeText !== '') (mark as ArrowMark).size = normalizeArrowSize(Number(sizeText));
    }
    if (data.has('customColor')) mark.color = String(data.get('color'));
    else delete mark.color;
    editor.updateMark(mark);
    editDialog.close();
  });

  function syncEditColor(): void {
    edit.color.disabled = !edit.customColor.checked;
    if (edit.color.disabled) {
      const kind = edit.kind.value as MarkKind;
      edit.color.value = (markKinds[kind] ?? markKinds.note).color;
    }
  }
  edit.kind.addEventListener('change', syncEditColor);
  edit.customColor.addEventListener('change', syncEditColor);
  edit.label.addEventListener('input', () => edit.label.setCustomValidity(''));
  edit.value.addEventListener('input', () => edit.label.setCustomValidity(''));
  editDialog.addEventListener('close', () => edit.label.setCustomValidity(''));

  element<HTMLButtonElement>('#delete-mark').onclick = () => {
    if (!editMark) return;
    editor.removeMark(editMark.id);
    editDialog.close();
  };
  for (const button of document.querySelectorAll<HTMLButtonElement>('button[data-tool]')) {
    button.onclick = () => editor.setTool(button.dataset.tool as Editor['tool']);
  }
  // 鼠标点过任意按钮后释放焦点，随后按 Space 才是“抓手平移”而不是再次激活该按钮。
  // 键盘激活（Enter/Space 触发 click）不走 pointerup，因此不影响可访问性。
  for (const button of document.querySelectorAll<HTMLButtonElement>('button')) {
    button.addEventListener('pointerup', () => button.blur());
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-boolean]')) {
    button.onclick = () => void editor.booleanSelection(button.dataset.boolean as BooleanOperation);
  }
  element<HTMLButtonElement>('#shape-delete').onclick = () => editor.deleteSelectedShapes();
  element<HTMLButtonElement>('#shape-clear').onclick = () => editor.clearShapeSelection();

  element<HTMLButtonElement>('#add-layer').onclick = () => {
    const next = withNewLayer(editor.project);
    editor.activeLayerId = next.layerId;
    editor.commit(next.project);
  };
  element<HTMLButtonElement>('#layer-up').onclick = () => {
    const next = withReorderedLayers(editor.project, editor.activeLayerId, 1);
    if (next) editor.commit(next);
  };
  element<HTMLButtonElement>('#layer-down').onclick = () => {
    const next = withReorderedLayers(editor.project, editor.activeLayerId, -1);
    if (next) editor.commit(next);
  };
  element<HTMLButtonElement>('#delete-layer').onclick = () => {
    const next = withRemovedLayer(editor.project, editor.activeLayerId);
    if (!next) return;
    editor.activeLayerId = next.activeLayerId;
    editor.commit(next.project);
  };
  element<HTMLInputElement>('#layer-opacity').addEventListener('input', event => {
    const input = event.target as HTMLInputElement;
    editor.previewOpacity(Number(input.value) / 100);
    element<HTMLOutputElement>('#opacity-value').value = `${input.value}%`;
  });
  element<HTMLInputElement>('#layer-opacity').addEventListener('change', () => editor.commitOpacity());
  element<HTMLSelectElement>('#object-layer').onchange = event =>
    editor.moveSelectionToLayer((event.target as HTMLSelectElement).value);

  element<HTMLButtonElement>('#edit-selected').onclick = () => {
    const mark = editor.project.marks.find(item => item.id === editor.selection);
    if (!mark) return;
    if (mark.shape === 'text') editor.beginText(mark as TextMark);
    else openEdit(mark);
  };
  element<HTMLButtonElement>('#delete-selected').onclick = () => editor.removeSelection();
  element<HTMLButtonElement>('#undo').onclick = () => editor.undoChange();
  element<HTMLButtonElement>('#redo').onclick = () => editor.redoChange();

  // 缩放读数只投影临时视口，不进入项目/历史。
  const zoomReset = element<HTMLButtonElement>('#zoom-reset');
  const syncZoom = (): void => {
    const percent = Math.round(editor.viewport.zoom * 100);
    zoomReset.textContent = `${percent}%`;
    zoomReset.setAttribute('aria-label', `当前缩放 ${percent}%，回到 100%`);
  };

  // 捕捉类型标记跟随世界点投影到屏幕；未命中时完全隐藏，不打扰画布。
  const snapBadge = element<HTMLElement>('#snap-badge');
  const snapBadgeLabel = element<HTMLElement>('#snap-badge-label');
  let activeSnap: SnapResult | null = null;
  const positionSnapBadge = (): void => {
    if (!activeSnap) {
      snapBadge.hidden = true;
      return;
    }
    const board = element<SVGSVGElement>('#board');
    const frame = board.parentElement?.getBoundingClientRect() ?? board.getBoundingClientRect();
    const screen = editor.viewport.worldToScreen(activeSnap.point);
    snapBadge.hidden = false;
    snapBadge.dataset.kind = activeSnap.type;
    snapBadgeLabel.textContent = SNAP_LABELS[activeSnap.type];
    const width = snapBadge.offsetWidth;
    const height = snapBadge.offsetHeight;
    let left = screen.x - frame.left + 12;
    let top = screen.y - frame.top + 12;
    if (left + width > frame.width - 8) left = screen.x - frame.left - width - 12;
    if (top + height > frame.height - 8) top = screen.y - frame.top - height - 12;
    snapBadge.style.left = `${Math.max(8, left)}px`;
    snapBadge.style.top = `${Math.max(8, top)}px`;
  };
  editor.onSnapChange = snap => {
    activeSnap = snap;
    positionSnapBadge();
  };

  editor.onViewportChange = () => {
    syncZoom();
    positionSnapBadge();
    // #shape-actions / #selection-actions 是 board-wrap 内的 absolute 层，
    // viewBox 变化不会带动它们；缩放、平移、resize 都必须重新投影到对象上方。
    schedulePosition();
  };
  element<HTMLButtonElement>('#zoom-out').onclick = () => editor.zoomView(1 / 1.2);
  element<HTMLButtonElement>('#zoom-in').onclick = () => editor.zoomView(1.2);
  zoomReset.onclick = () => editor.resetView();
  element<HTMLButtonElement>('#zoom-fit').onclick = () => editor.fitView();
  syncZoom();

  // 磁吸开关按产品结论持久化；视口/捕捉都不进入项目与撤销历史。
  const snapToggle = element<HTMLButtonElement>('#snap-toggle');
  const syncSnapToggle = (): void => {
    const enabled = editor.snapEnabled;
    snapToggle.setAttribute('aria-pressed', String(enabled));
    snapToggle.title = enabled
      ? '磁吸已开启：端点 / 中点 / 圆心 / 象限点 / 栅格（按住 Alt 临时关闭）'
      : '磁吸已关闭';
  };
  editor.setSnapEnabled(readSnapPreference());
  syncSnapToggle();
  snapToggle.onclick = () => {
    editor.setSnapEnabled(!editor.snapEnabled);
    writeSnapPreference(editor.snapEnabled);
    syncSnapToggle();
  };

  element<HTMLButtonElement>('#toggle-layers').onclick = () => togglePanel('#layers-panel', '#toggle-layers');
  element<HTMLButtonElement>('#close-layers').onclick = () => closePanel('#layers-panel', '#toggle-layers');
  element<HTMLButtonElement>('#toggle-inspector').onclick = () => togglePanel('#inspector', '#toggle-inspector');
  element<HTMLButtonElement>('#close-inspector').onclick = () => closePanel('#inspector', '#toggle-inspector');

  interface PasteGesture {
    consumed: boolean;
    /** readText 已经完成粘贴；同一按键迟到的 paste 事件只负责去重。 */
    pasted: boolean;
    /** 按键时间；无 paste 事件的浏览器不能让手势无限堆积。 */
    at: number;
    /** 读取失败/确认空剪贴板后的内存回退；真实 paste 事件先到时会取消它。 */
    fallbackTimer?: number;
  }
  /** 只给真实 paste 事件留出反应窗口；超过后才使用内存副本。 */
  const PASTE_FALLBACK_DELAY_MS = 400;
  const pasteGestures: PasteGesture[] = [];
  const prunePasteGestures = (now: number): void => {
    while (pasteGestures.length && now - pasteGestures[0].at > 2_000) pasteGestures.shift();
    // 极端重复按键也不能让去重队列无限增长；只保留最近的手势。
    while (pasteGestures.length >= 8) pasteGestures.shift();
  };
  /**
   * paste 事件只认最近 1 秒内的一次按键；优先最新的未完成手势，
   * 避免浏览器不派发 paste 时留下的旧手势吞掉下一次真实粘贴。
   */
  const claimPasteGesture = (now: number): PasteGesture | undefined => {
    for (let index = pasteGestures.length - 1; index >= 0; index--) {
      if (now - pasteGestures[index].at <= 1_000) {
        return pasteGestures.splice(index, 1)[0];
      }
    }
    return undefined;
  };
  /** readText 异步返回后，焦点可能已进入输入框；此时一律交给控件原生粘贴。 */
  const canPasteToCanvas = (): boolean =>
    !editor.textEditing && !document.querySelector('dialog[open]') &&
    !isTextEntryTarget(document.activeElement);

  const scheduleMemoryPasteFallback = (gesture: PasteGesture): void => {
    if (gesture.fallbackTimer !== undefined) return;
    // 同一按键的真实 paste 事件可能稍后到达；事件一到就取消回退，
    // 避免先用旧内存副本粘贴、又把外部文本/图片事件误判为“已处理”而阻止原生粘贴。
    gesture.fallbackTimer = window.setTimeout(() => {
      gesture.fallbackTimer = undefined;
      if (gesture.consumed || !canPasteToCanvas()) return;
      if (editor.pasteSelection()) {
        gesture.consumed = true;
        gesture.pasted = true;
        // 粘贴结果里可能已带“参考图层回退到 X”的说明，降级提示只追加不覆盖。
        const detail = element<HTMLElement>('#notice').textContent ?? '';
        editor.notify(detail ? `剪贴板不可用，已在本标签页内粘贴。${detail}` : '剪贴板不可用，已在本标签页内粘贴。');
      } else {
        editor.notify('剪贴板不可用，且没有可粘贴的 SimSketch 对象。');
      }
    }, PASTE_FALLBACK_DELAY_MS);
  };

  /**
   * readText 对仅含 image/png 或文件的剪贴板会 resolve 空字符串（Chromium 实测），
   * 因此空串不能直接当作空剪贴板。返回 null 表示无法确认 types，应等真实 paste 事件。
   */
  const clipboardHasNonText = async (): Promise<boolean | null> => {
    const clipboard = navigator.clipboard as Clipboard & {
      read?: () => Promise<Array<{types: readonly string[]}>>;
    };
    if (typeof clipboard.read !== 'function') return null;
    try {
      const items = await clipboard.read();
      return items.some(item => item.types.some(type => type !== 'text/plain'));
    } catch {
      return null;
    }
  };

  /**
   * 键盘粘贴走 async Clipboard API 读取真实内容：
   * - 只有本应用 payload 才进入画布，普通文本/图片保持原生；
   * - 空串先检查 ClipboardItem.types，确认只有空文本且没有真实 paste 事件才回退内存副本；
   * - 读取被拒时也等 paste 事件决定，不抢先用旧对象。
   */
  const readKeyboardPaste = async (gesture: PasteGesture): Promise<void> => {
    let text: string;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      if (gesture.consumed) return;
      scheduleMemoryPasteFallback(gesture);
      return;
    }
    if (gesture.consumed || !canPasteToCanvas()) return;
    if (text) {
      gesture.consumed = true;
      gesture.pasted = editor.pasteSelection(text);
      return;
    }
    // 空串可能是“空剪贴板”，也可能是图片/文件/富文本；先读 types 区分。
    const hasNonText = await clipboardHasNonText();
    if (gesture.consumed) return;
    if (hasNonText !== false) {
      // 确认有非文本内容：手势留给真实 paste 事件，由浏览器执行原生粘贴。
      if (hasNonText === true) {
        gesture.consumed = true;
        gesture.pasted = false;
      }
      return;
    }
    if (!canPasteToCanvas()) return;
    scheduleMemoryPasteFallback(gesture);
  };
  document.addEventListener('keydown', event => {
    if (editor.textEditing || document.querySelector('dialog[open]')) return;
    // 只有文本类输入框保留原生编辑行为；range/select/color 不吞画布快捷键。
    const target = event.target instanceof Element ? event.target : null;
    const editingText = isTextEntryTarget(event.target);
    // 复制/剪切/原地复制只在有选择时接管；粘贴总是留给 paste 事件优先读系统剪贴板。
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !editingText) {
      const key = event.key.toLowerCase();
      if (key === 'c' && editor.copySelection()) {
        event.preventDefault();
        return;
      }
      if (key === 'x' && editor.cutSelection()) {
        event.preventDefault();
        return;
      }
      if (key === 'd') {
        // Ctrl/⌘+D 在非文本焦点下始终属于画布：没有选择时也不能弹出浏览器书签对话框。
        event.preventDefault();
        editor.duplicateSelection();
        return;
      }
      if (key === 'v') {
        const gesture: PasteGesture = {consumed: false, pasted: false, at: Date.now()};
        prunePasteGestures(gesture.at);
        pasteGestures.push(gesture);
        void readKeyboardPaste(gesture);
        return;
      }
    }
    // 任何可聚焦控件上的 Space 都优先保留原生激活；只有画布/空白区域进入空格平移。
    const nativeSpace = Boolean(target?.closest(
      'button, summary, a, label, select, input, textarea, [role="button"], [contenteditable]'));
    if (event.code === 'Space' && !editingText && !nativeSpace &&
      !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      editor.setSpacePressed(true);
      return;
    }
    // 只有文本输入框内的 Esc 属于控件自身；滑块/下拉聚焦时仍可取消画布状态。
    if (event.key === 'Escape') {
      if (editingText) return;
      if (editor.cancelTransform()) return;
      if (!editor.cancelPolygon()) editor.cancelSelection();
      return;
    }
    // 输入框里的 Enter 属于原生控件，不能拿去闭合多边形。
    if (!editingText && event.key === 'Enter' && editor.finishPolygon()) {
      event.preventDefault();
      return;
    }
    // 视口快捷键只在没有文本输入焦点和组合键时生效。
    if (!editingText && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const key = event.key.toLowerCase();
      if (key === 'f') {
        event.preventDefault();
        editor.fitView();
        return;
      }
      if (event.key === '0') {
        event.preventDefault();
        editor.resetView();
        return;
      }
      if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        editor.zoomView(1.2);
        return;
      }
      if (event.key === '-' || event.key === '_') {
        event.preventDefault();
        editor.zoomView(1 / 1.2);
        return;
      }
      if (key === 'e') {
        event.preventDefault();
        editor.setTool('eraser');
        return;
      }
    }
    if (editingText) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      // 文本控件内的撤销必须走浏览器原生文本历史，不能回退画布项目。
      event.preventDefault();
      if (event.shiftKey) editor.redoChange();
      else editor.undoChange();
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      // 图形和标注共用同一删除入口，仍只占一步 undo。
      if (!editor.deleteSelection()) return;
      event.preventDefault();
    }
  });
  // 系统剪贴板读取由用户粘贴手势授权：只有本应用 payload 才进入画布。
  // 真实 paste 事件携带普通文字/图片时保持原生行为；剪贴板为空才回退内存副本。
  document.addEventListener('paste', event => {
    if (editor.textEditing || document.querySelector('dialog[open]')) return;
    // readText 可能已经处理了同一次按键：认领手势，迟到的 paste 事件只去重。
    // 过期手势不能被 context-menu 原生粘贴误认领，否则会吞掉真实粘贴。
    const now = Date.now();
    prunePasteGestures(now);
    const gesture = claimPasteGesture(now);
    if (gesture) {
      if (gesture.fallbackTimer !== undefined) {
        window.clearTimeout(gesture.fallbackTimer);
        gesture.fallbackTimer = undefined;
      }
      gesture.consumed = true;
    }
    if (isTextEntryTarget(event.target)) return;
    const text = event.clipboardData?.getData('text/plain') ?? '';
    const hasClipboardData = hasPasteContent(event.clipboardData);
    if (gesture?.pasted) {
      event.preventDefault();
      return;
    }
    // 图片/富文本保持原生；普通文字交给编辑器，只有本应用 payload 才 preventDefault。
    if (hasClipboardData && !text) return;
    // 系统剪贴板为空或浏览器没有提供数据时，才回退到上一次的内存副本。
    if (editor.pasteSelection(hasClipboardData ? text : undefined)) event.preventDefault();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Alt') editor.setSnapSuppressed(true);
  });
  document.addEventListener('keyup', event => {
    if (event.code === 'Space') editor.setSpacePressed(false);
    if (event.key === 'Alt') editor.setSnapSuppressed(false);
  });
  window.addEventListener('blur', () => {
    editor.setSpacePressed(false);
    editor.setSnapSuppressed(false);
  });

  editor.onChange = render;
  editor.onToolChange = tool => {
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-tool]:not(svg)')) {
      button.setAttribute('aria-pressed', String(button.dataset.tool === tool));
    }
    element<HTMLElement>('#hint').textContent = TOOL_MESSAGES[tool];
    syncEraserUi();
    syncMarkStyleControls();
  };
  syncEraserUi();
  render();
}

/**
 * paste 事件是否带来真实内容。只有 text/plain 且为空时仍视为空剪贴板（浏览器常见的空粘贴事件），
 * 这样才能回退内存副本；图片/富文本必须保持原生行为，不能误粘贴旧对象。
 */
function hasPasteContent(data: DataTransfer | null): boolean {
  if (!data) return false;
  if (data.files.length) return true;
  if (data.getData('text/plain')) return true;
  return Array.from(data.types).some(type => type !== 'text/plain');
}

/** 文本输入控件保留原生复制粘贴；画布快捷键不能抢走输入焦点里的 C/V/X。 */
function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const editable = target.closest('[contenteditable]');
  if (editable && editable.getAttribute('contenteditable') !== 'false') return true;
  const entry = target.closest('textarea, input');
  return entry instanceof HTMLTextAreaElement ||
    (entry instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(entry.type));
}

function editField<T extends FormField = HTMLInputElement>(form: HTMLFormElement, name: string): T {
  const field = form.elements.namedItem(name);
  if (!field || field instanceof RadioNodeList) throw new Error(`找不到表单字段：${name}`);
  return field as T;
}

function togglePanel(panelSelector: string, buttonSelector: string): void {
  const panel = element<HTMLElement>(panelSelector);
  panel.hidden = !panel.hidden;
  element<HTMLButtonElement>(buttonSelector).setAttribute('aria-expanded', String(!panel.hidden));
  if (panel.hidden) return;
  const other = panelSelector === '#inspector' ? ['#layers-panel', '#toggle-layers'] : ['#inspector', '#toggle-inspector'];
  closePanel(other[0], other[1]);
}

function closePanel(panelSelector: string, buttonSelector: string): void {
  element<HTMLElement>(panelSelector).hidden = true;
  element<HTMLButtonElement>(buttonSelector).setAttribute('aria-expanded', 'false');
}

/** 磁吸是企业级绘图偏好：跨会话记住，但不写项目；隐私模式读取失败时回退开启。 */
function readSnapPreference(): boolean {
  try {
    return localStorage.getItem(SNAP_PREFERENCE_KEY) !== 'off';
  } catch {
    return true;
  }
}

function writeSnapPreference(enabled: boolean): void {
  writePreference(SNAP_PREFERENCE_KEY, enabled ? 'on' : 'off');
}

/** 工具偏好统一读取；隐私模式/禁用存储回退 null，由调用方给默认值。 */
function readPreference(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function readStoredNumber(key: string): number | null {
  const raw = readPreference(key);
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function writePreference(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 存储被禁用时只影响下次启动的默认值，不阻断当前会话。
  }
}
