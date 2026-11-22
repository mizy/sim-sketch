import {canBoolean} from './geometry.ts';
import type {BooleanOperation} from './geometry.ts';
import {withNewLayer, withRemovedLayer, withReorderedLayers} from './layers.ts';
import {markColor, markKinds, markLegend} from './project.ts';
import type {Mark, MarkKind, TextMark} from './project.ts';
import type {Editor} from './editor.ts';
import {TOOL_MESSAGES} from './editor-types.ts';
import type {Brush} from './editor-types.ts';

type FormField = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

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
    color: editField(editForm, 'color')
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

  const renderShapeActions = (): void => {
    const selected = editor.selectedShapes;
    const shapes = editor.project.shapes.filter(shape => selected.includes(shape.id));
    element<HTMLElement>('#shape-actions').hidden = !shapes.length;
    element<HTMLElement>('#shape-count').textContent = `已选 ${shapes.length} 个图形`;
    const allowed = canBoolean(shapes);
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-boolean]')) button.disabled = !allowed;
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
    element<HTMLButtonElement>('#undo').disabled = !editor.canUndo;
    element<HTMLButtonElement>('#redo').disabled = !editor.canRedo;
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

  element<HTMLButtonElement>('#toggle-layers').onclick = () => togglePanel('#layers-panel', '#toggle-layers');
  element<HTMLButtonElement>('#close-layers').onclick = () => closePanel('#layers-panel', '#toggle-layers');
  element<HTMLButtonElement>('#toggle-inspector').onclick = () => togglePanel('#inspector', '#toggle-inspector');
  element<HTMLButtonElement>('#close-inspector').onclick = () => closePanel('#inspector', '#toggle-inspector');

  document.addEventListener('keydown', event => {
    if (editor.textEditing || document.querySelector('dialog[open]')) return;
    if (event.key === 'Escape') {
      editor.cancelSelection();
      return;
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && editor.selectedShapes.length) {
      event.preventDefault();
      editor.deleteSelectedShapes();
      return;
    }
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'z') return;
    event.preventDefault();
    if (event.shiftKey) editor.redoChange();
    else editor.undoChange();
  });

  editor.onChange = render;
  editor.onToolChange = tool => {
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-tool]:not(svg)')) {
      button.setAttribute('aria-pressed', String(button.dataset.tool === tool));
    }
    element<HTMLElement>('#hint').textContent = TOOL_MESSAGES[tool];
  };
  render();
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
