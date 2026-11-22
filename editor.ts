import {boardPoint, drawOverlay} from './board.ts';
import {translateShape} from './geometry.ts';
import type {ArcShape, BooleanOperation, Point, Shape} from './geometry.ts';
import {normalizeProject, saveProject} from './project.ts';
import type {Mark, Project, StoredProject, TextMark} from './project.ts';
import {createMarkForTool, createShape, extendShape as applyShapePoint,
  extendStroke as applyStrokePoint, readDebugSnap, toolShapeType, translatedMark, validArc} from './editor-drawing.ts';
import {InlineTextEditor} from './editor-text.ts';
import {booleanSelection} from './editor-boolean.ts';
import type {Brush, EditorOptions, Tool} from './editor-types.ts';
import {buildScene} from './scene.ts';
import {RendererHost} from './renderer-host.ts';
import {fitBoardView, sceneViewport} from './viewport.ts';

type Drawing =
  | {mode: 'mark-create'; id: number; mark: Mark}
  | {mode: 'move'; id: number; original: Mark; mark: Mark; start: Point; client: Point; moved: boolean}
  | {mode: 'shape-create'; id: number; shape: Shape}
  | {mode: 'shape-move'; id: number; originals: Shape[]; shapes: Shape[]; start: Point; client: Point; moved: boolean}
  | {mode: 'text'; mark: null};

/**
 * @entry 编辑器状态机：项目/选择/撤销、指针交互、文本输入与异步布尔。
 * 渲染器 Host 与 DOM 投影都从这里接收显式调用，不靠 effect 驱动。
 */
export class Editor {
  project: Project;
  selection: string | null = null;
  selectedShapes: string[] = [];
  activeLayerId: string;
  tool: Tool = 'pen';
  brush: Brush = 'auto';
  customBrushColor = '#2e4f77';
  onChange: (() => void) | undefined;
  onToolChange: ((tool: Tool) => void) | undefined;

  readonly host: RendererHost;
  private readonly debugSnap = readDebugSnap();
  private drawing: Drawing | null = null;
  private pendingArc: {shape: ArcShape} | null = null;
  private readonly text: InlineTextEditor;
  private opacityPreview: {id: string; value: number} | null = null;
  private revision = 0;
  /** 布尔运算异步等待期间，任何画布交互都会让已发出的操作失效。 */
  private interactionEpoch = 0;
  private pendingSave: Promise<void> = Promise.resolve();
  private readonly undo: Project[] = [];
  private readonly redo: Project[] = [];

  constructor(private readonly options: EditorOptions) {
    this.project = normalizeProject({});
    this.activeLayerId = this.project.layers[0].id;
    this.onChange = options.onChange;
    this.onToolChange = options.onToolChange;
    this.host = new RendererHost({board: options.board, paint: () => this.paint()});
    this.text = new InlineTextEditor({
      board: options.board,
      input: options.textInput,
      project: () => this.project,
      paint: () => this.paint(),
      render: () => this.render(),
      commit: next => this.commit(next),
      addMark: mark => this.addMark(mark),
      select: id => { this.selection = id; },
      activateLayer: id => { this.activeLayerId = id; },
      setTextDrawing: active => { this.drawing = active ? {mode: 'text', mark: null} : null; }
    });
    this.bindPointer();
  }

  /** 从草稿/空项目启动，不写入 undo 历史。 */
  load(project: StoredProject, saved: boolean): void {
    this.resetTransientState();
    this.project = normalizeProject(project);
    this.activeLayerId = this.project.layers.at(-1)!.id;
    if (saved) {
      this.options.status.dataset.state = 'saved';
      this.options.status.textContent = '草稿已保存在此设备';
    }
    this.render();
  }

  get canUndo(): boolean {
    return this.undo.length > 0;
  }

  get canRedo(): boolean {
    return this.redo.length > 0;
  }

  get textEditing(): boolean {
    return this.text.active;
  }

  get changeVersion(): number {
    return this.revision;
  }

  /** 等待当前草稿落盘；更新 Service Worker 前避免刷新丢失最后一次保存。 */
  whenSaved(): Promise<void> {
    return this.pendingSave;
  }

  cancelSelection(): void {
    // 取消也算一次交互：延迟中的布尔结果必须失效，否则 Esc 之后仍会提交旧选择。
    this.interactionEpoch++;
    // 图形与标注共用 Esc：任一选择存在都要清理，否则 #selection-actions 会残留。
    if (!this.pendingArc && !this.selectedShapes.length && !this.selection) return;
    this.pendingArc = null;
    this.selectedShapes = [];
    this.selection = null;
    this.render();
  }

  /** 显式取消图形选择；与 Esc 一样必须让等待中的异步布尔结果失效。 */
  clearShapeSelection(): void {
    this.cancelSelection();
  }

  setTool(next: Tool): void {
    this.interactionEpoch++;
    if (this.text.active) this.text.finish();
    this.tool = next;
    this.pendingArc = null;
    this.selectedShapes = [];
    this.options.board.dataset.tool = next;
    this.onToolChange?.(next);
    this.render();
  }

  setBrush(next: Brush, customColor = this.customBrushColor): void {
    this.brush = next;
    this.customBrushColor = customColor;
  }

  resize(): void {
    const {width, height} = fitBoardView(this.options.board, this.project);
    if (!width || !height) return;
    this.host.resize(width, height, Math.min(devicePixelRatio || 1, 2));
    this.text.position();
    this.paint();
  }

  render(): void {
    this.paint();
    this.onChange?.();
  }

  commit(next: Project): void {
    this.undo.push(this.project);
    if (this.undo.length > 35) this.undo.shift();
    this.redo.length = 0;
    this.apply(next);
  }

  apply(next: StoredProject): void {
    this.resetTransientState();
    this.project = normalizeProject(next);
    if (!this.project.layers.some(layer => layer.id === this.activeLayerId)) {
      this.activeLayerId = this.project.layers.at(-1)!.id;
    }
    if (this.selection && !this.project.marks.some(mark => mark.id === this.selection)) this.selection = null;
    this.selectedShapes = this.selectedShapes.filter(id => this.project.shapes.some(shape => shape.id === id));
    const snapshot = this.project;
    const current = ++this.revision;
    this.options.status.dataset.state = 'saving';
    this.options.status.textContent = '正在保存到此设备…';
    this.render();
    this.pendingSave = this.pendingSave.then(() => saveProject(snapshot)).then(() => {
      if (this.revision !== current) return;
      this.options.status.dataset.state = 'saved';
      this.options.status.textContent = '草稿已保存在此设备';
    }).catch(() => {
      if (this.revision === current) this.options.status.textContent = '草稿保存失败，请导出以保留修改';
    });
  }

  undoChange(): void {
    const previous = this.undo.pop();
    if (!previous) return;
    this.redo.push(this.project);
    this.selection = null;
    this.selectedShapes = [];
    this.apply(previous);
  }

  redoChange(): void {
    const next = this.redo.pop();
    if (!next) return;
    this.undo.push(this.project);
    this.selection = null;
    this.selectedShapes = [];
    this.apply(next);
  }

  focusMark(mark: Mark): void {
    this.selection = mark.id;
    this.selectedShapes = [];
    this.activeLayerId = mark.layerId;
    this.render();
  }

  beginText(mark: TextMark): void {
    this.text.begin(mark);
  }

  addMark(mark: Mark): void {
    this.selection = mark.id;
    this.selectedShapes = [];
    this.commit({...this.project, marks: [...this.project.marks, mark]});
  }

  addShape(shape: Shape): void {
    this.selection = null;
    this.selectedShapes = [shape.id];
    this.commit({...this.project, shapes: [...this.project.shapes, shape]});
  }

  updateMark(mark: Mark): void {
    if (this.project.marks.some(existing => existing.id === mark.id)) {
      this.commit({...this.project, marks: this.project.marks.map(existing => existing.id === mark.id ? mark : existing)});
    } else this.addMark(mark);
  }

  removeMark(id: string): void {
    this.selection = null;
    this.commit({...this.project, marks: this.project.marks.filter(mark => mark.id !== id)});
  }

  removeSelection(): void {
    const id = this.selection;
    if (!id) return;
    this.removeMark(id);
  }

  moveSelectionToLayer(layerId: string): void {
    this.activeLayerId = layerId;
    this.commit({...this.project, marks: this.project.marks.map(mark =>
      mark.id === this.selection ? {...mark, layerId} : mark)});
  }

  deleteSelectedShapes(): void {
    if (!this.selectedShapes.length) return;
    const removed = new Set(this.selectedShapes);
    this.selectedShapes = [];
    this.commit({...this.project, shapes: this.project.shapes.filter(shape => !removed.has(shape.id))});
  }

  async booleanSelection(operation: BooleanOperation): Promise<void> {
    await booleanSelection({
      project: this.project,
      selectedShapes: this.selectedShapes,
      notice: this.options.notice,
      revision: this.revision,
      beginInteraction: () => ++this.interactionEpoch,
      isInterrupted: (epoch, revision) => epoch !== this.interactionEpoch || revision !== this.revision,
      commit: next => this.commit(next),
      setSelection: id => { this.selection = id; },
      setSelectedShapes: ids => { this.selectedShapes = ids; },
      refresh: () => this.onChange?.()
    }, operation);
  }

  replaceCanvas(project: Project): void {
    this.selection = null;
    this.selectedShapes = [];
    this.options.notice.textContent = '';
    this.commit(project);
  }

  previewOpacity(value: number): void {
    this.opacityPreview = {id: this.activeLayerId, value};
    this.paint();
  }

  commitOpacity(): void {
    if (!this.opacityPreview) return;
    const {id, value} = this.opacityPreview;
    this.opacityPreview = null;
    if ((this.project.layers.find(layer => layer.id === id)?.opacity ?? 1) !== value) {
      this.commit({...this.project, layers: this.project.layers.map(layer =>
        layer.id === id ? {...layer, opacity: value} : layer)});
    } else this.render();
  }

  activateLayer(id: string): void {
    this.activeLayerId = id;
    this.opacityPreview = null;
  }

  /**
   * 项目被替换或回退前丢弃所有未提交的半成品。
   * 否则 pendingArc/drawing 会在下一帧继续绘制，下一次点击还会把旧圆弧写进新项目。
   */
  private resetTransientState(): void {
    this.interactionEpoch++;
    this.drawing = null;
    this.pendingArc = null;
    this.opacityPreview = null;
    this.text.cancel();
  }

  private paint(): void {
    let state = this.project;
    if (this.drawing?.mode === 'move' && this.drawing.moved) {
      const moving = this.drawing;
      state = {...state, marks: state.marks.map(mark => mark.id === moving.original.id ? moving.mark : mark)};
    }
    if (this.drawing?.mode === 'shape-move' && this.drawing.moved) {
      const moving = this.drawing;
      state = {...state, shapes: state.shapes.map(shape => moving.shapes.find(item => item.id === shape.id) ?? shape)};
    }
    if (this.opacityPreview) {
      state = {...state, layers: state.layers.map(layer =>
        layer.id === this.opacityPreview!.id ? {...layer, opacity: this.opacityPreview!.value} : layer)};
    }
    const temporaryMark = this.drawing?.mode === 'mark-create' ? this.drawing.mark : null;
    const temporaryShape = this.drawing?.mode === 'shape-create' ? this.drawing.shape : this.pendingArc?.shape ?? null;
    const scene = buildScene(state, {viewport: sceneViewport(this.options.board), revision: this.revision,
      temporaryMark, temporaryShape, selectedMark: this.selection, selectedShapes: this.selectedShapes,
      snap: this.debugSnap});
    this.host.draw(scene);
    drawOverlay(this.options.board, state, {selectedMark: this.selection,
      selectedShapes: this.selectedShapes, hitProxies: true});
    if (this.text.active) this.text.hideMark();
  }

  private finishArc(point: Point): void {
    if (!this.pendingArc) return;
    const shape = this.pendingArc.shape;
    this.pendingArc = null;
    shape.points[1] = point;
    if (!validArc(shape)) {
      this.options.notice.textContent = '圆弧需要三个不共线的点，请重新拖出弦再确定弯向。';
      this.render();
      return;
    }
    this.addShape(shape);
  }

  private bindPointer(): void {
    const board = this.options.board;
    board.addEventListener('pointerdown', this.pointerDown);
    board.addEventListener('dblclick', this.doubleClick);
    board.addEventListener('pointermove', this.pointerMove);
    board.addEventListener('pointerup', this.pointerUp);
    for (const type of ['pointercancel', 'lostpointercapture'] as const) {
      board.addEventListener(type, this.pointerCancel);
    }
  }

  private readonly pointerDown = (event: PointerEvent): void => {
    if (!event.isPrimary || event.button !== 0) return;
    const board = this.options.board;
    this.interactionEpoch++;
    const point = boardPoint(board, event);
    if (this.tool === 'arc' && this.pendingArc) {
      event.preventDefault();
      this.finishArc(point);
      return;
    }
    if (this.drawing) return;
    if (this.tool === 'select') {
      const target = event.target as Element | null;
      const shapeNode = target?.closest<SVGGElement>('[data-shape-id]');
      const shape = this.project.shapes.find(item => item.id === shapeNode?.dataset.shapeId);
      if (shape) {
        event.preventDefault();
        this.selection = null;
        this.activeLayerId = shape.layerId;
        if (event.shiftKey) {
          this.selectedShapes = this.selectedShapes.includes(shape.id) ?
            this.selectedShapes.filter(id => id !== shape.id) : [...this.selectedShapes, shape.id];
          this.render();
          return;
        }
        if (!this.selectedShapes.includes(shape.id)) this.selectedShapes = [shape.id];
        const originals = this.project.shapes.filter(item => this.selectedShapes.includes(item.id));
        board.setPointerCapture(event.pointerId);
        this.drawing = {mode: 'shape-move', id: event.pointerId, originals, shapes: originals,
          start: point, client: [event.clientX, event.clientY], moved: false};
        this.render();
        return;
      }
      const group = target?.closest<SVGGElement>('[data-id]');
      const mark = this.project.marks.find(item => item.id === group?.dataset.id);
      if (!mark) { this.selection = null; this.selectedShapes = []; this.render(); return; }
      event.preventDefault();
      this.selection = mark.id;
      this.selectedShapes = [];
      this.activeLayerId = mark.layerId;
      board.setPointerCapture(event.pointerId);
      this.drawing = {mode: 'move', id: event.pointerId, original: mark, mark, start: point,
        client: [event.clientX, event.clientY], moved: false};
      this.render();
      return;
    }
    if (this.tool === 'text') {
      const target = event.target as Element | null;
      const group = target?.closest<SVGGElement>('[data-id]');
      const mark = this.project.marks.find((item): item is TextMark =>
        item.id === group?.dataset.id && item.shape === 'text');
      event.preventDefault();
      this.selectedShapes = [];
      const next = mark ?? createMarkForTool('text', point, this.brush, this.activeLayerId, this.customBrushColor) as TextMark;
      this.beginText(next);
      return;
    }
    const shapeType = toolShapeType(this.tool);
    if (shapeType) {
      board.setPointerCapture(event.pointerId);
      this.drawing = {mode: 'shape-create', id: event.pointerId,
        shape: createShape(shapeType, point, this.brush, this.activeLayerId, this.customBrushColor)};
      this.paint();
      return;
    }
    board.setPointerCapture(event.pointerId);
    this.drawing = {mode: 'mark-create', id: event.pointerId,
      mark: createMarkForTool(this.tool, point, this.brush, this.activeLayerId, this.customBrushColor)};
    this.paint();
  };

  private readonly doubleClick = (event: MouseEvent): void => {
    if (this.tool !== 'select') return;
    const target = document.elementFromPoint(event.clientX, event.clientY);
    const group = target?.closest<SVGGElement>('[data-id]');
    const mark = this.project.marks.find(item => item.id === group?.dataset.id);
    if (!mark) return;
    if (mark.shape === 'text') this.beginText(mark);
    else this.onOpenMark?.(mark);
  };

  private readonly pointerMove = (event: PointerEvent): void => {
    if (this.pendingArc && this.tool === 'arc') {
      this.pendingArc.shape.points[1] = boardPoint(this.options.board, event);
      this.paint();
      return;
    }
    if (!this.drawing || this.drawing.mode === 'text' || this.drawing.id !== event.pointerId) return;
    if (this.drawing.mode === 'move') {
      if (Math.hypot(event.clientX - this.drawing.client[0], event.clientY - this.drawing.client[1]) < 3 && !this.drawing.moved) return;
      const point = boardPoint(this.options.board, event);
      const moving = this.drawing;
      moving.moved = true;
      moving.mark = translatedMark(moving.original, point[0] - moving.start[0], point[1] - moving.start[1]);
    } else if (this.drawing.mode === 'shape-move') {
      if (Math.hypot(event.clientX - this.drawing.client[0], event.clientY - this.drawing.client[1]) < 3 && !this.drawing.moved) return;
      const point = boardPoint(this.options.board, event);
      const moving = this.drawing;
      moving.moved = true;
      moving.shapes = moving.originals.map(shape =>
        translateShape(shape, point[0] - moving.start[0], point[1] - moving.start[1]));
    } else if (this.drawing.mode === 'shape-create') applyShapePoint(this.drawing.shape, event, this.options.board);
    else applyStrokePoint(this.drawing.mark, event, this.options.board);
    this.paint();
  };

  private readonly pointerUp = (event: PointerEvent): void => {
    if (!this.drawing || this.drawing.mode === 'text' || this.drawing.id !== event.pointerId) return;
    if (this.drawing.mode === 'move') {
      const {original, mark, moved} = this.drawing;
      this.drawing = null;
      if (moved) this.commit({...this.project, marks: this.project.marks.map(item => item.id === original.id ? mark : item)});
      else this.render();
      return;
    }
    if (this.drawing.mode === 'shape-move') {
      const {shapes, moved} = this.drawing;
      this.drawing = null;
      if (moved) {
        const movedById = new Map(shapes.map(shape => [shape.id, shape]));
        this.commit({...this.project, shapes: this.project.shapes.map(shape => movedById.get(shape.id) ?? shape)});
      } else this.render();
      return;
    }
    if (this.drawing.mode === 'shape-create') {
      applyShapePoint(this.drawing.shape, event, this.options.board);
      const {shape} = this.drawing;
      this.drawing = null;
      if (shape.type === 'arc') {
        const [start, , end] = shape.points;
        if (Math.hypot(end[0] - start[0], end[1] - start[1]) >= 4) {
          this.pendingArc = {shape: {...shape, points: [start, end, end]}};
        }
        this.paint();
        return;
      }
      const wide = shape.type === 'rect' && Math.abs(shape.b[0] - shape.a[0]) >= 4 && Math.abs(shape.b[1] - shape.a[1]) >= 4;
      const long = shape.type === 'line' && Math.hypot(shape.points[1][0] - shape.points[0][0], shape.points[1][1] - shape.points[0][1]) >= 4;
      const round = shape.type === 'circle' && shape.radius >= 3;
      if (wide || long || round) this.addShape(shape);
      else this.render();
      return;
    }
    applyStrokePoint(this.drawing.mark, event, this.options.board);
    const mark = this.drawing.mark;
    this.drawing = null;
    const longEnough = mark.shape === 'region' || mark.shape === 'arrow'
      ? Math.hypot(mark.b[0] - mark.a[0], mark.b[1] - mark.a[1]) >= 4
      : false;
    if (mark.shape === 'pen' || longEnough) this.addMark(mark);
    else this.render();
  };

  private readonly pointerCancel = (event: PointerEvent): void => {
    if (!this.drawing || this.drawing.mode === 'text' || this.drawing.id !== event.pointerId) return;
    this.drawing = null;
    this.render();
  };

  /** double-click 编辑回调由 UI 注入；避免 Editor 依赖编辑对话框 DOM。 */
  onOpenMark: ((mark: Mark) => void) | undefined;
}
