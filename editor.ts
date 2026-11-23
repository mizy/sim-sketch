import {translatedMark} from './annotations.ts';
import {drawOverlay} from './board.ts';
import {BoardViewport, boardPoint, boardScreenDistance, screenConstant, wheelZoomFactor} from './viewport.ts';
import {arcCircle, polygonHasPoint, polygonIssue, polygonIssueText, samePoint, translateShape} from './geometry.ts';
import {clipboardContent, looksLikeSimSketchClipboard, parseClipboard, pasteClipboard, PASTE_OFFSET,
  serializeClipboard, writeClipboardText} from './clipboard.ts';
import type {ClipboardContent} from './clipboard.ts';
import type {ArcShape, BooleanOperation, Point, Shape} from './geometry.ts';
import {drawTransformHandles} from './transform-overlay.ts';
import {applyMatrix, frameHandles, frameScaleFactors, frameScaleMatrix, handleFromTarget,
  rotationMatrix, selectionFrame, snapRotationDelta, transformMark, transformShape} from './transform.ts';
import type {AffineMatrix, ScaleHandle, TransformFrame, TransformHandle} from './transform.ts';
import {normalizeProject, normalizeProjectWithRepair, PROJECT_LIMIT_NOTICE, PROJECT_REPAIR_NOTICE,
  projectSize, projectWithinLimits, saveProject} from './project.ts';
import type {Mark, Project, StoredProject, TextMark} from './project.ts';
import {DEFAULT_BRUSH_WIDTH, normalizeBrushWidth} from './mark-width.ts';
import {DEFAULT_ARROW_SIZE, DEFAULT_TEXT_FONT_SIZE, normalizeArrowSize,
  normalizeTextFontSize} from './mark-style.ts';
import {createEraseSession, eraseAlong, eraseSessionEmpty, erasedProject} from './eraser.ts';
import type {EraseSession} from './eraser.ts';
import {fitPenMark} from './pen-fit.ts';
import type {PenCurveKind, PenFitMode} from './pen-fit.ts';
import {createMarkForTool, createPolygonShape, createShape, extendShape as applyShapePoint,
  extendStroke as applyStrokePoint, polygonPreviewShape, readDebugSnap, toolShapeType,
  validArc} from './editor-drawing.ts';
import {InlineTextEditor} from './editor-text.ts';
import {booleanSelection} from './editor-boolean.ts';
import type {Brush, EditorOptions, Tool} from './editor-types.ts';
import {buildScene, gridSpec, gridSpacingForViewport} from './scene.ts';
import {RendererHost} from './renderer-host.ts';
import type {SnapMarker} from './renderer.ts';
import {createSnapIndex, DEFAULT_SNAP_THRESHOLD_PX} from './snap.ts';
import type {SnapIndex, SnapResult} from './snap.ts';

type Drawing =
  | {mode: 'mark-create'; id: number; mark: Mark}
  | {mode: 'move'; id: number; original: Mark; mark: Mark; start: Point; client: Point; moved: boolean;
    excluded: ReadonlySet<string>}
  | {mode: 'shape-create'; id: number; shape: Shape}
  | {mode: 'shape-move'; id: number; originals: Shape[]; shapes: Shape[]; start: Point; client: Point; moved: boolean;
    excluded: ReadonlySet<string>}
  | {mode: 'transform'; id: number; handle: TransformHandle; frame: TransformFrame;
    previewFrame: TransformFrame; originals: Shape[]; originalMarks: Mark[]; shapes: Shape[]; marks: Mark[];
    start: Point; startAngle: number; client: Point; moved: boolean; uniformNotice: boolean;
    excluded: ReadonlySet<string>}
  | {mode: 'erase'; id: number; session: EraseSession; last: Point}
  | {mode: 'text'; mark: null};

/** 逐点绘制的多边形草稿；尚未提交，Esc/切换工具会整体丢弃。 */
interface PolygonDraft {
  points: Point[];
  hover: Point;
}

/** 点回起点的像素容差；世界单位会随缩放变化，因此用屏幕距离判定。 */
const POLYGON_CLOSE_TOLERANCE_PX = 10;
/** 无需排除任何对象时复用同一空集合，避免 pointermove 每次分配。 */
const NO_EXCLUDED_OBJECTS: ReadonlySet<string> = new Set();
/** 双击闭合后短暂忽略下一次按下，避免双击第一点后立刻开启新草稿。 */
const POLYGON_REOPEN_GUARD_MS = 350;

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
  /** 当前画笔粗细：只作用于之后新画的内容，不写回已有标注。 */
  brushWidth = DEFAULT_BRUSH_WIDTH;
  /** 新建箭头的头部长度；产品口径为 8–96，刷新回 21。 */
  arrowSize = DEFAULT_ARROW_SIZE;
  /** 新建文字的字号；产品口径为 8–96，刷新回 22。 */
  textFontSize = DEFAULT_TEXT_FONT_SIZE;
  /** 橡皮擦尺寸（CSS px 直径）独立于画笔粗细记忆；命中半径按当前 zoom 折算成世界单位。 */
  eraserWidth = 12;
  /** 手绘自动拟合偏好；只作用于画笔，不影响直线/矩形/圆/箭头等工具。 */
  penFit: PenFitMode = 'off';
  penCurve: PenCurveKind = 'cubic';
  /** 磁吸开关是本地交互偏好，不进入项目/草稿/undo。 */
  snapEnabled = true;
  onChange: (() => void) | undefined;
  onToolChange: ((tool: Tool) => void) | undefined;
  onViewportChange: ((zoom: number) => void) | undefined;
  /** 命中/离开捕捉时通知 UI 显示或隐藏类型标记。 */
  onSnapChange: ((snap: SnapResult | null) => void) | undefined;
  /** 变换/移动预览时让操作条跟随对象，不触发整份 UI 重建。 */
  onPreview: (() => void) | undefined;

  readonly host: RendererHost;
  readonly viewport: BoardViewport;
  private readonly debugSnap = readDebugSnap();
  private readonly snapIndex: SnapIndex;
  private snap: SnapResult | null = null;
  /** 按住 Alt 临时关闭磁吸；松开后下一次指针事件恢复。 */
  private snapSuppressed = false;
  private drawing: Drawing | null = null;
  /** 空格/中键拖拽平移；与绘制状态互斥，不改项目也不写 undo。 */
  private panning: {id: number; client: Point} | null = null;
  private spacePressed = false;
  private gestureZoom = 1;
  private polygonDraft: PolygonDraft | null = null;
  /** 负无穷表示本会话还没闭合过多边形，避免页面加载后的前 350ms 吞掉首次点击。 */
  private lastPolygonFinish = Number.NEGATIVE_INFINITY;
  private pendingArc: {shape: ArcShape} | null = null;
  private readonly text: InlineTextEditor;
  private opacityPreview: {id: string; value: number} | null = null;
  /** 选中标注的尺寸滑块预览；pointerup/change 才写一次 undo。 */
  private markStylePreview: {id: string; size?: number; fontSize?: number} | null = null;
  private revision = 0;
  /** 布尔运算异步等待期间，任何画布交互都会让已发出的操作失效。 */
  private interactionEpoch = 0;
  private pendingSave: Promise<void> = Promise.resolve();
  private readonly undo: Project[] = [];
  private readonly redo: Project[] = [];
  /** 内存副本保证系统剪贴板不可用时仍能粘贴；不进入项目、草稿或 undo。 */
  private clipboard: ClipboardContent | null = null;
  private clipboardText = '';
  /** 连续粘贴的递增次数；复制/剪切后归零，首次粘贴偏移 16，之后每次再 +16。 */
  private pasteIndex = 0;
  /** 本标签页内单调递增的剪贴板时间戳，避免同一毫秒复制 A/B 无法判断新旧。 */
  private lastClipboardStamp = 0;
  /** copiedAt 只在同一会话内比较；跨标签页只认系统剪贴板当前内容。 */
  private readonly clipboardSessionId = newClipboardSessionId();

  constructor(private readonly options: EditorOptions) {
    this.project = normalizeProject({});
    this.activeLayerId = this.project.layers[0].id;
    this.onChange = options.onChange;
    this.onToolChange = options.onToolChange;
    this.onViewportChange = options.onViewportChange;
    this.onSnapChange = options.onSnapChange;
    this.onPreview = options.onPreview;
    this.snapIndex = createSnapIndex(this.project);
    this.viewport = new BoardViewport(options.board, () => this.project);
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
    const {project: normalized, repair} = normalizeProjectWithRepair(project);
    this.project = normalized;
    this.snapIndex.rebuild(this.project);
    this.activeLayerId = this.project.layers.at(-1)!.id;
    // 已保存草稿只框内容：把 960×600 基准并入远坐标内容会把 zoom 夹到 10%，
    // 导致合法对象落在视口之外、加载后整块画布空白。基准只属于新建/示例/空项目。
    this.viewport.fitProject(this.project, !saved);
    if (saved) {
      this.options.status.dataset.state = 'saved';
      this.options.status.textContent = '草稿已保存在此设备';
    }
    // 旧草稿可能超过当前预算：原样载入，不静默截断；只提示后续新增会被拒绝。
    if (!projectWithinLimits(this.project)) {
      this.options.notice.textContent = repaired(repair)
        ? `${PROJECT_REPAIR_NOTICE} ${PROJECT_LIMIT_NOTICE}` : PROJECT_LIMIT_NOTICE;
    } else if (repaired(repair)) {
      this.options.notice.textContent = PROJECT_REPAIR_NOTICE;
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

  get polygonDrawing(): boolean {
    return this.polygonDraft !== null;
  }

  get changeVersion(): number {
    return this.revision;
  }

  /** 等待当前草稿落盘；更新 Service Worker 前避免刷新丢失最后一次保存。 */
  whenSaved(): Promise<void> {
    return this.pendingSave;
  }

  cancelSelection(): void {
    // 变换中的 Esc 只撤销预览，不丢选择；由 UI 先调用 cancelTransform。
    if (this.drawing?.mode === 'transform') {
      this.cancelTransform();
      return;
    }
    // 取消也算一次交互：延迟中的布尔结果必须失效，否则 Esc 之后仍会提交旧选择。
    this.interactionEpoch++;
    const cancelledPolygon = this.polygonDraft !== null;
    this.polygonDraft = null;
    this.clearSnap();
    if (cancelledPolygon) this.options.notice.textContent = '已取消未闭合的多边形。';
    // 图形与标注共用 Esc：任一选择存在都要清理，否则 #selection-actions 会残留。
    if (!this.pendingArc && !this.selectedShapes.length && !this.selection) {
      if (cancelledPolygon) this.render();
      return;
    }
    this.pendingArc = null;
    this.selectedShapes = [];
    this.selection = null;
    this.markStylePreview = null;
    this.render();
  }

  /** Esc 取消本次缩放/旋转：丢弃预览，不写 undo，选择保持不变。 */
  cancelTransform(): boolean {
    if (this.drawing?.mode !== 'transform') return false;
    this.drawing = null;
    this.clearSnap();
    this.render();
    return true;
  }

  /** Enter / 双击/点回起点都走这里；返回 true 表示键盘事件已被消费。 */
  finishPolygon(): boolean {
    const draft = this.polygonDraft;
    if (!draft) return false;
    const issue = polygonIssue(draft.points);
    this.polygonDraft = null;
    this.clearSnap();
    if (issue) {
      this.options.notice.textContent = polygonIssueText(issue);
      this.render();
      return true;
    }
    const shape = createPolygonShape(draft.points, this.brush, this.brushWidth,
      this.activeLayerId, this.customBrushColor);
    this.lastPolygonFinish = performance.now();
    this.options.notice.textContent = '';
    this.addShape(shape);
    return true;
  }

  /** Esc 专用：只有存在草稿时才消费事件，避免抢掉普通选择取消。 */
  cancelPolygon(): boolean {
    if (!this.polygonDraft) return false;
    this.cancelSelection();
    return true;
  }

  /** 显式取消图形选择；与 Esc 一样必须让等待中的异步布尔结果失效。 */
  clearShapeSelection(): void {
    this.cancelSelection();
  }

  setTool(next: Tool): void {
    this.interactionEpoch++;
    if (this.text.active) this.text.finish();
    if (this.polygonDraft) {
      this.polygonDraft = null;
      this.options.notice.textContent = '未闭合的多边形已取消。';
    }
    this.tool = next;
    this.pendingArc = null;
    this.selectedShapes = [];
    this.markStylePreview = null;
    this.clearSnap();
    this.options.board.dataset.tool = next;
    this.onToolChange?.(next);
    this.render();
  }

  setBrush(next: Brush, customColor = this.customBrushColor): void {
    this.brush = next;
    this.customBrushColor = customColor;
  }

  /** 滑块变化只更新后续绘制参数，不产生项目提交，也不重绘已有内容。 */
  setBrushWidth(width: number): void {
    this.brushWidth = normalizeBrushWidth(width);
  }

  /** 当前活动中可编辑的标注；供操作条同步箭头/文字尺寸滑块。 */
  get selectedMark(): Mark | null {
    return this.selection ? this.project.marks.find(mark => mark.id === this.selection) ?? null : null;
  }

  /** 新建箭头默认尺寸；不写项目，也不触发重绘。 */
  setArrowSize(size: number): void {
    this.arrowSize = normalizeArrowSize(size);
  }

  /** 新建文字默认字号；不写项目，也不触发重绘。 */
  setTextFontSize(size: number): void {
    this.textFontSize = normalizeTextFontSize(size);
  }

  /** 选中箭头的实时预览；指针松开/滑块 change 时提交为一步 undo。 */
  previewSelectedArrowSize(size: number): void {
    this.previewMarkStyle({size: normalizeArrowSize(size)});
  }

  previewSelectedTextFontSize(size: number): void {
    this.previewMarkStyle({fontSize: normalizeTextFontSize(size)});
  }

  /** 提交当前尺寸预览；没有变化时不产生空 undo。 */
  commitSelectedMarkStyle(): void {
    const preview = this.markStylePreview;
    this.markStylePreview = null;
    if (!preview) {
      this.render();
      return;
    }
    const mark = this.project.marks.find(item => item.id === preview.id);
    if (!mark) {
      this.render();
      return;
    }
    let next = mark;
    if (mark.shape === 'arrow' && preview.size !== undefined && mark.size !== preview.size) {
      next = {...mark, size: preview.size};
    } else if (mark.shape === 'text' && preview.fontSize !== undefined && mark.fontSize !== preview.fontSize) {
      next = {...mark, fontSize: preview.fontSize};
    }
    if (next === mark) {
      this.render();
      return;
    }
    this.commit({...this.project, marks: this.project.marks.map(item => item.id === mark.id ? next : item)});
  }

  /** 剪贴板降级、非法内容等一次性用户提示。 */
  notify(message: string): void {
    this.options.notice.textContent = message;
  }

  private previewMarkStyle(patch: {size?: number; fontSize?: number}): void {
    const mark = this.selectedMark;
    if (!mark) return;
    if (mark.shape === 'arrow' && patch.size !== undefined) {
      this.markStylePreview = {id: mark.id, size: patch.size};
      this.paint();
      this.onPreview?.();
    } else if (mark.shape === 'text' && patch.fontSize !== undefined) {
      this.markStylePreview = {id: mark.id, fontSize: patch.fontSize};
      this.paint();
      this.onPreview?.();
    }
  }

  /** 橡皮擦尺寸复用 mark-width 的 1–24 范围，但独立保存，不覆盖画笔粗细。 */
  setEraserWidth(width: number): void {
    this.eraserWidth = normalizeBrushWidth(width);
  }

  /** 手绘拟合设置只影响下一次松开画笔；已有笔迹不重算。 */
  setPenFit(mode: PenFitMode, curve: PenCurveKind): void {
    this.penFit = mode;
    this.penCurve = curve;
  }

  /** 工具栏开关；偏好由 UI 持久化，Editor 只持有当前会话状态。 */
  setSnapEnabled(enabled: boolean): void {
    if (this.snapEnabled === enabled) return;
    this.snapEnabled = enabled;
    if (!enabled) this.clearSnap();
    this.paint();
  }

  /** Alt 按下时立即隐藏标记；松开后等下一次指针移动重新判定。 */
  setSnapSuppressed(active: boolean): void {
    if (this.snapSuppressed === active) return;
    this.snapSuppressed = active;
    if (active && this.snap) {
      this.clearSnap();
      this.paint();
    }
  }

  /**
   * @entry 所有交互（绘制/移动，以及后续缩放/旋转）共用的捕捉入口。
   * 阈值按屏幕像素折算，因此 10% 与 800% 下手感一致；Alt 可临时关闭。
   */
  snapAt(rawPoint: Point, exclude: ReadonlySet<string> = NO_EXCLUDED_OBJECTS,
    altKey = false): SnapResult | null {
    if (!this.snapEnabled || this.snapSuppressed || altKey) {
      this.clearSnap();
      return null;
    }
    const zoom = this.viewport.zoom;
    const result = this.snapIndex.resolve(rawPoint, {
      scale: zoom,
      thresholdPx: DEFAULT_SNAP_THRESHOLD_PX,
      grid: {spacing: gridSpacingForViewport(zoom), origin: gridSpec.origin},
      exclude
    });
    this.setSnap(result);
    return result;
  }

  /** 只取坐标的便捷版本；未命中时原样返回 rawPoint。 */
  snapPoint(rawPoint: Point, exclude: ReadonlySet<string> = NO_EXCLUDED_OBJECTS,
    altKey = false): Point {
    return this.snapAt(rawPoint, exclude, altKey)?.point ?? rawPoint;
  }

  /** 当前选择：图形多选优先，否则是单个标注。 */
  private selectionFrom(project: Project): {shapes: Shape[]; marks: Mark[]} {
    const shapes = project.shapes.filter(shape => this.selectedShapes.includes(shape.id));
    const mark = this.selection ? project.marks.find(item => item.id === this.selection) : undefined;
    return {shapes, marks: mark ? [mark] : []};
  }

  private rememberSelection(): ClipboardContent | null {
    const content = clipboardContent(this.project, this.selectedShapes, this.selection);
    if (!content) return null;
    // 每次复制带单调时间戳 + nonce：系统剪贴板异步写入失败/晚到时，仍能判断哪份更新；
    // 时间戳单调递增，同一毫秒内复制 A/B 时旧 payload 仍会被识别为过期。
    const stamped: ClipboardContent = {...content,
      copiedAt: this.nextClipboardStamp(), nonce: crypto.randomUUID(),
      sessionId: this.clipboardSessionId};
    this.clipboard = stamped;
    this.clipboardText = serializeClipboard(stamped);
    this.pasteIndex = 0;
    void writeClipboardText(this.clipboardText).then(written => {
      // 只在这次复制仍是内存最新副本时提示，避免覆盖后续操作的状态。
      if (written || this.clipboard !== stamped) return;
      this.options.notice.textContent =
        `已复制 ${describeClipboard(stamped)}；系统剪贴板不可用，已在本标签页内保留副本，仍可按 Ctrl/⌘+V 粘贴。`;
    });
    return stamped;
  }

  /** 同一毫秒内连续复制也必须有序：nonce 负责唯一性，时间戳负责先后。 */
  private nextClipboardStamp(): number {
    const now = Date.now();
    const next = Math.max(now, this.lastClipboardStamp + 1);
    // 外部时间戳已由 parseClipboard 限窗；这里再做一次安全整数兜底，避免 +1 饱和。
    this.lastClipboardStamp = Number.isSafeInteger(next) ? next : now;
    return this.lastClipboardStamp;
  }

  /**
   * 系统剪贴板里的旧 payload 不能覆盖刚刚复制到内存的新内容。
   * copiedAt 只在同一会话内可比较：另一个标签页可能先复制、后写入，时间戳更旧但内容才是系统剪贴板的当前值。
   * 缺少 sessionId 的旧 payload 按同会话处理，保留升级前的去重语义。
   */
  private isStaleExternal(external: ClipboardContent): boolean {
    const externalAt = external.copiedAt;
    const memory = this.clipboard;
    const memoryAt = memory?.copiedAt;
    if (externalAt === undefined || memoryAt === undefined) return false;
    if (external.sessionId && memory?.sessionId && external.sessionId !== memory.sessionId) return false;
    return externalAt < memoryAt;
  }

  /** 粘贴落到当前活动图层；参考图层不可作为目标，回退到最后一个普通图层。 */
  private pasteTarget(): {id: string; name: string; fallback: string | null} {
    const referenceId = this.project.referenceLayerId;
    const normal = this.project.layers.filter(layer => layer.id !== referenceId);
    const targetId = normal.some(layer => layer.id === this.activeLayerId) ? this.activeLayerId :
      normal.at(-1)?.id ?? this.project.layers[0].id;
    const name = this.project.layers.find(layer => layer.id === targetId)?.name ?? targetId;
    const fallback = targetId === this.activeLayerId ? null :
      this.activeLayerId === referenceId ? '当前图层为参考图层' : '当前图层不可用';
    return {id: targetId, name, fallback};
  }

  private pasteOptions(dx: number, dy: number,
    target = this.pasteTarget()): {dx: number; dy: number; targetLayerId: string} {
    return {dx, dy, targetLayerId: target.id};
  }

  /** 粘贴与原地复制共用提交路径：一次 commit、自动选中新对象，可立即走移动/变换捕捉。 */
  private applyPaste(pasted: ClipboardContent, label: string, target = this.pasteTarget()): boolean {
    if (!pasted.shapes.length && !pasted.marks.length) return false;
    const previousShapes = this.selectedShapes;
    const previousMark = this.selection;
    // 操作条互斥：混合 payload 以图形为主选择，标注仍已落盘但不再同时占用 #selection-actions。
    this.selectedShapes = pasted.shapes.map(shape => shape.id);
    this.selection = pasted.shapes.length ? null : pasted.marks[0]?.id ?? null;
    const committed = this.commit({...this.project,
      shapes: [...this.project.shapes, ...pasted.shapes],
      marks: [...this.project.marks, ...pasted.marks]});
    if (!committed) {
      this.selectedShapes = previousShapes;
      this.selection = previousMark;
      this.render();
      return false;
    }
    const fallback = target.fallback ? `${target.fallback}，已粘贴到「${target.name}」。` : '';
    this.options.notice.textContent =
      `${fallback}${label} ${describeClipboard(pasted)}；已自动选中，可直接拖动、缩放或旋转。`;
    return true;
  }

  private selectionFrameFor(project: Project): TransformFrame | null {
    // 14 world 只是手柄外扩量；frame.half 仍是对象真实尺寸，缩放基准不会被 padding 污染。
    return selectionFrame(this.selectionFrom(project), screenConstant(14, this.viewport.zoom));
  }

  /** 变换预览复用 gesture 开始时的 frame，避免大路径在 pointermove 里反复重扫。 */
  private selectionHandleFrame(project: Project): TransformFrame | null {
    return this.drawing?.mode === 'transform' ?
      this.drawing.previewFrame : this.selectionFrameFor(project);
  }


  /** 操作条只读角度：仅旋转手势期间显示，避免普通选择时撑宽操作条。 */
  transformAngleLabel(): string | null {
    if (this.drawing?.mode !== 'transform' || this.drawing.handle !== 'rotate') return null;
    const frame = this.selectionHandleFrame(this.project);
    if (!frame?.rotatable) return null;
    // 显示口径与落盘一致：190° 显示为 -170°，避免同一对象两个角度值。
    const degrees = ((frame.rotation * 180 / Math.PI % 360) + 540) % 360 - 180;
    return `${Math.round(degrees)}°`;
  }

  private beginTransform(handle: TransformHandle, event: PointerEvent): boolean {
    const targets = this.selectionFrom(this.project);
    const frame = this.selectionFrameFor(this.project);
    if (!frame) return false;
    if (handle === 'rotate' ? !frame.rotatable : !frameHandles(frame).includes(handle)) return false;
    const raw = boardPoint(this.options.board, event);
    const center = frame.center;
    this.options.board.setPointerCapture(event.pointerId);
    this.clearSnap();
    this.drawing = {
      mode: 'transform', id: event.pointerId, handle, frame, previewFrame: frame,
      originals: targets.shapes, originalMarks: targets.marks,
      shapes: targets.shapes, marks: targets.marks,
      start: raw,
      startAngle: Math.atan2(raw[1] - center[1], raw[0] - center[0]),
      client: [event.clientX, event.clientY], moved: false, uniformNotice: false,
      excluded: new Set([...targets.shapes.map(shape => shape.id), ...targets.marks.map(mark => mark.id)])
    };
    return true;
  }

  /**
   * 变换预览：矩形/圈选在自身局部轴缩放，旋转只在 Shift 时吸附 15°。
   * 这里只更新预览，不提交项目；指针松开时才写一次 undo。
   */
  private updateTransform(event: PointerEvent): void {
    if (this.drawing?.mode !== 'transform') return;
    const drawing = this.drawing;
    const raw = boardPoint(this.options.board, event);
    // 缩放手柄沿用既有端点捕捉；旋转只用 Shift 15° 吸附，避免捕捉改变角度。
    const point = drawing.handle === 'rotate' ? raw : this.snapPoint(raw, drawing.excluded, event.altKey);
    let matrix: AffineMatrix;
    let nextFrame: TransformFrame;
    let changed = false;
    if (drawing.handle === 'rotate') {
      const center = drawing.frame.center;
      let delta = Math.atan2(point[1] - center[1], point[0] - center[0]) - drawing.startAngle;
      // Shift 吸附的是对象的绝对角度，而不是本次增量：已旋转 7° 时再按 Shift
      // 应落到 15° 网格（15°/30°…），而不是 7°+15k。
      if (event.shiftKey) delta = snapRotationDelta(drawing.frame.rotation, delta);
      matrix = rotationMatrix(center, delta);
      nextFrame = {...drawing.frame, rotation: drawing.frame.rotation + delta};
      changed = Math.abs(delta) > 1e-9;
    } else {
      const uniform = event.shiftKey || drawing.frame.mode === 'uniform';
      if (uniform && !event.shiftKey && !drawing.uniformNotice) {
        this.options.notice.textContent = '该选择包含圆形、圆弧或旋转对象，仅支持等比缩放，已按等比处理。';
        drawing.uniformNotice = true;
      }
      const factors = frameScaleFactors(drawing.frame, drawing.handle as ScaleHandle, point, uniform, drawing.start);
      matrix = frameScaleMatrix(drawing.frame, factors.sx, factors.sy, drawing.handle as ScaleHandle);
      const half: Point = [Math.abs(drawing.frame.half[0] * factors.sx),
        Math.abs(drawing.frame.half[1] * factors.sy)];
      const pad: Point = [Math.max(0, drawing.frame.handleHalf[0] - drawing.frame.half[0]),
        Math.max(0, drawing.frame.handleHalf[1] - drawing.frame.half[1])];
      nextFrame = {
        ...drawing.frame,
        center: applyMatrix(drawing.frame.center, matrix),
        half,
        handleHalf: [Math.max(half[0], pad[0]), Math.max(half[1], pad[1])]
      };
      changed = Math.abs(factors.sx - 1) > 1e-9 || Math.abs(factors.sy - 1) > 1e-9;
    }
    const reject = (message: string): void => {
      this.options.notice.textContent = message;
      // 拒绝本次落点后清掉上一次有效预览：否则 pointerup 会提交与当前指针不一致的陈旧几何。
      drawing.shapes = [];
      drawing.marks = [];
      drawing.previewFrame = drawing.frame;
      drawing.moved = false;
      drawing.client = [event.clientX, event.clientY];
    };
    const shapes: Shape[] = [];
    for (const shape of drawing.originals) {
      const next = transformShape(shape, matrix);
      if (!next) {
        reject('该选择包含无法保持矩形/圈选语义的变换，请逐个沿自身轴缩放。');
        return;
      }
      if (!validTransformedShape(next, shape)) {
        reject('已到最小尺寸：矩形/路径至少保留原始尺寸（下限 4），圆半径至少 1，圆弧弦长至少 4。');
        return;
      }
      shapes.push(next);
    }
    const marks: Mark[] = [];
    for (const mark of drawing.originalMarks) {
      const next = transformMark(mark, matrix);
      if (!next) {
        reject('旋转后的圈选区域暂不支持非等比缩放，请按住 Shift 等比缩放。');
        return;
      }
      marks.push(next);
    }
    drawing.shapes = shapes;
    drawing.marks = marks;
    drawing.previewFrame = nextFrame;
    drawing.client = [event.clientX, event.clientY];
    drawing.moved = changed;
  }

  resize(): void {
    const {width, height} = this.viewport.resize();
    if (!width || !height) return;
    this.host.resize(width, height, Math.min(devicePixelRatio || 1, 2));
    this.text.position();
    this.paint();
    this.onViewportChange?.(this.viewport.zoom);
  }

  /** F：只框内容。 */
  fitView(): void {
    this.viewport.fitProject();
    this.afterViewportChange();
  }

  /** 首屏/新建：内容 ∪ 基准画布，避免示例草图被放大到盖住用户输入。 */
  fitInitialView(): void {
    this.viewport.fitProject(this.project, true);
    this.afterViewportChange();
  }

  /** 0：回到原点视图（100%），不改变任何内容坐标。 */
  resetView(): void {
    this.viewport.reset();
    this.afterViewportChange();
  }

  /** +/-：以画板中心为锚点缩放。 */
  zoomView(factor: number): void {
    if (this.viewport.zoomBy(factor)) this.afterViewportChange();
  }

  /** 空格按住时进入抓手模式；不抢输入框与按钮的原生 Space 行为。 */
  setSpacePressed(active: boolean): void {
    if (this.spacePressed === active) return;
    this.spacePressed = active;
    this.syncPanCursor();
  }

  render(): void {
    this.paint();
    this.onChange?.();
  }

  /**
   * 提交一次可撤销修改。超出预算的新增会被拒绝并提示，绝不先写入再静默截断。
   * 返回 false 时项目、undo、选择都保持原状。
   */
  commit(next: Project): boolean {
    if (!this.withinCommitBudget(next)) {
      this.options.notice.textContent = PROJECT_LIMIT_NOTICE;
      this.render();
      return false;
    }
    this.undo.push(this.project);
    if (this.undo.length > 35) this.undo.shift();
    this.redo.length = 0;
    this.apply(next);
    return true;
  }

  /** 允许删除/清理超预算的旧草稿；只有规模继续增长时才拒绝。 */
  private withinCommitBudget(next: Project): boolean {
    if (projectWithinLimits(next)) return true;
    const current = projectSize(this.project);
    const candidate = projectSize(next);
    return candidate.objects <= current.objects && candidate.vertices <= current.vertices;
  }

  apply(next: StoredProject): void {
    this.resetTransientState();
    const {project, repair} = normalizeProjectWithRepair(next);
    this.project = project;
    if (repaired(repair)) this.options.notice.textContent = PROJECT_REPAIR_NOTICE;
    this.snapIndex.rebuild(this.project);
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
    this.pasteIndex = 0;
    this.redo.push(this.project);
    this.selection = null;
    this.selectedShapes = [];
    this.apply(previous);
  }

  redoChange(): void {
    const next = this.redo.pop();
    if (!next) return;
    this.pasteIndex = 0;
    this.undo.push(this.project);
    this.selection = null;
    this.selectedShapes = [];
    this.apply(next);
  }

  /** @entry Ctrl/⌘+C：复制选中图形与/或标注；系统剪贴板被拒时仍保留内存副本。 */
  copySelection(): boolean {
    const content = this.rememberSelection();
    if (!content) return false;
    this.options.notice.textContent = `已复制 ${describeClipboard(content)}；按 Ctrl/⌘+V 粘贴。`;
    return true;
  }

  /** Ctrl/⌘+X：复制后删除，一次 undo 可完整恢复。 */
  cutSelection(): boolean {
    const content = this.rememberSelection();
    if (!content) return false;
    const shapeIds = new Set(content.shapes.map(shape => shape.id));
    const markIds = new Set(content.marks.map(mark => mark.id));
    this.selectedShapes = [];
    this.selection = null;
    this.commit({...this.project,
      shapes: this.project.shapes.filter(shape => !shapeIds.has(shape.id)),
      marks: this.project.marks.filter(mark => !markIds.has(mark.id))});
    this.options.notice.textContent = `已剪切 ${describeClipboard(content)}；按 Ctrl/⌘+V 粘贴。`;
    return true;
  }

  /** Ctrl/⌘+D：原地复制并选中新对象；不覆盖复制链，也不写系统剪贴板。 */
  duplicateSelection(): boolean {
    const content = clipboardContent(this.project, this.selectedShapes, this.selection);
    if (!content) return false;
    const target = this.pasteTarget();
    return this.applyPaste(pasteClipboard(content, this.pasteOptions(0, 0, target)), '已原地复制', target);
  }

  /**
   * @entry Ctrl/⌘+V：系统剪贴板里的本应用 payload 优先；只有没有真实剪贴板内容时
   * （键盘兜底/空剪贴板）才回退内存副本。普通文字或图片不得误粘贴旧对象。
   * 每次连续粘贴在模型坐标上累加 16 单位，且只在真正添加对象后递增。
   */
  pasteSelection(text?: string | null): boolean {
    const fromClipboard = text !== undefined && text !== null;
    const external = fromClipboard ? parseClipboard(text) : null;
    if (fromClipboard && !external) {
      // 普通外部文本保持原生行为；只有看起来是本应用 payload 时才提示解析失败。
      if (looksLikeSimSketchClipboard(text)) {
        this.options.notice.textContent = '剪贴板内容不是 SimSketch 对象。';
      }
      return false;
    }
    const stale = external ? this.isStaleExternal(external) : false;
    if (external && !stale) {
      const serialized = serializeClipboard(external);
      if (serialized !== this.clipboardText) {
        this.clipboard = external;
        this.clipboardText = serialized;
        this.pasteIndex = 0;
        // 只有同会话时间戳才能抬高本页水位；跨标签页时以系统剪贴板当前内容为准。
        if (external.copiedAt !== undefined && external.sessionId === this.clipboardSessionId) {
          this.lastClipboardStamp = Math.max(this.lastClipboardStamp, external.copiedAt);
        }
      }
    }
    const content = stale ? this.clipboard : external ?? this.clipboard;
    if (!content) return false;
    const pasteIndex = this.pasteIndex + 1;
    const offset = PASTE_OFFSET * pasteIndex;
    const target = this.pasteTarget();
    if (!this.applyPaste(pasteClipboard(content, this.pasteOptions(offset, offset, target)), '已粘贴', target)) {
      this.options.notice.textContent = '粘贴失败：内容超出画布范围或规模预算。';
      return false;
    }
    this.pasteIndex = pasteIndex;
    return true;
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
    const previousShapes = this.selectedShapes;
    const previousMark = this.selection;
    this.selection = mark.id;
    this.selectedShapes = [];
    if (this.commit({...this.project, marks: [...this.project.marks, mark]})) return;
    this.selection = previousMark;
    this.selectedShapes = previousShapes;
    this.render();
  }

  addShape(shape: Shape): void {
    const previousShapes = this.selectedShapes;
    const previousMark = this.selection;
    this.selection = null;
    this.selectedShapes = [shape.id];
    if (this.commit({...this.project, shapes: [...this.project.shapes, shape]})) return;
    this.selection = previousMark;
    this.selectedShapes = previousShapes;
    this.render();
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

  /** Delete/Backspace 的统一入口：图形多选与单个标注一起删除，仍只占一步 undo。 */
  deleteSelection(): boolean {
    const removed = new Set(this.selectedShapes);
    const markId = this.selection;
    if (!removed.size && !markId) return false;
    this.selectedShapes = [];
    this.selection = null;
    this.commit({...this.project,
      shapes: this.project.shapes.filter(shape => !removed.has(shape.id)),
      marks: this.project.marks.filter(mark => mark.id !== markId)});
    return true;
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
    this.pasteIndex = 0;
    this.options.notice.textContent = '';
    // 新画布保留基准画布取景；视口仍只是临时状态，不进项目也不进 undo。
    this.viewport.fitProject(project, true);
    this.commit(project);
    this.onViewportChange?.(this.viewport.zoom);
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
    this.panning = null;
    this.polygonDraft = null;
    this.pendingArc = null;
    this.opacityPreview = null;
    this.markStylePreview = null;
    this.text.cancel();
    this.clearSnap();
    this.syncPanCursor();
  }

  private afterViewportChange(): void {
    this.paint();
    this.text.position();
    this.onViewportChange?.(this.viewport.zoom);
  }

  private setSnap(next: SnapResult | null): void {
    if (sameSnap(this.snap, next)) return;
    this.snap = next;
    this.onSnapChange?.(next);
  }

  /** 清掉当前命中；返回是否确实有标记被移除。 */
  private clearSnap(): boolean {
    if (!this.snap) return false;
    this.setSnap(null);
    return true;
  }

  private syncPanCursor(): void {
    if (this.panning) this.options.board.dataset.pan = 'active';
    else if (this.spacePressed) this.options.board.dataset.pan = 'ready';
    else delete this.options.board.dataset.pan;
  }

  /** 橡皮擦尺寸是 CSS px，命中测试需要换算成当前 zoom 下的世界半径。 */
  private eraserRadiusWorld(): number {
    return screenConstant(this.eraserWidth / 2, this.viewport.zoom);
  }

  /** 项目 + 当前交互预览；渲染和选择手柄共用同一份投影，避免两套几何口径。 */
  private previewProject(): Project {
    let state = this.project;
    if (this.drawing?.mode === 'move' && this.drawing.moved) {
      const moving = this.drawing;
      state = {...state, marks: state.marks.map(mark => mark.id === moving.original.id ? moving.mark : mark)};
    }
    if (this.drawing?.mode === 'shape-move' && this.drawing.moved) {
      const moving = this.drawing;
      state = {...state, shapes: state.shapes.map(shape => moving.shapes.find(item => item.id === shape.id) ?? shape)};
    }
    if (this.drawing?.mode === 'transform' && this.drawing.moved) {
      const transform = this.drawing;
      const shapes = new Map(transform.shapes.map(shape => [shape.id, shape]));
      const marks = new Map(transform.marks.map(mark => [mark.id, mark]));
      state = {...state,
        shapes: state.shapes.map(shape => shapes.get(shape.id) ?? shape),
        marks: state.marks.map(mark => marks.get(mark.id) ?? mark)};
    }
    if (this.drawing?.mode === 'erase' && !eraseSessionEmpty(this.drawing.session)) {
      // 擦除只做排除预览；真正提交发生在 pointerup，因此一次拖动只有一步 undo。
      state = erasedProject(state, this.drawing.session) ?? state;
    }
    if (this.markStylePreview) {
      const preview = this.markStylePreview;
      state = {...state, marks: state.marks.map(mark => {
        if (mark.id !== preview.id) return mark;
        if (mark.shape === 'arrow' && preview.size !== undefined) return {...mark, size: preview.size};
        if (mark.shape === 'text' && preview.fontSize !== undefined) return {...mark, fontSize: preview.fontSize};
        return mark;
      })};
    }
    if (this.opacityPreview) {
      state = {...state, layers: state.layers.map(layer =>
        layer.id === this.opacityPreview!.id ? {...layer, opacity: this.opacityPreview!.value} : layer)};
    }
    return state;
  }

  private paint(): void {
    const state = this.previewProject();
    const temporaryMark = this.drawing?.mode === 'mark-create' ? this.drawing.mark : null;
    const temporaryShape = this.drawing?.mode === 'shape-create' ? this.drawing.shape :
      this.pendingArc?.shape ?? this.polygonPreview();
    const scene = buildScene(state, {viewport: this.viewport.renderViewport(), revision: this.revision,
      temporaryMark, temporaryShape, selectedMark: this.selection, selectedShapes: this.selectedShapes,
      snap: this.snapMarkers()});
    this.host.draw(scene);
    drawOverlay(this.options.board, state, {selectedMark: this.selection,
      selectedShapes: this.selectedShapes, hitProxies: true,
      hitScale: screenConstant(1, this.viewport.zoom)});
    const frame = this.tool === 'select' && !this.text.active ? this.selectionHandleFrame(state) : null;
    drawTransformHandles(this.options.board, frame, this.viewport.zoom);
    if (this.text.active) this.text.hideMark();
  }

  /** 临时边：已落顶点 + 当前指针；靠近起点时补一段闭合预览。 */
  private polygonPreview(): Shape | null {
    const draft = this.polygonDraft;
    if (!draft) return null;
    const {points, hover} = draft;
    const preview = samePoint(hover, points.at(-1)!) ? [...points] : [...points, hover];
    if (points.length >= 3 &&
      boardScreenDistance(this.options.board, hover, points[0]) <= POLYGON_CLOSE_TOLERANCE_PX) {
      preview.push(points[0]);
    }
    return polygonPreviewShape(preview, this.activeLayerId);
  }

  /**
   * 绘制中的磁吸/顶点提示沿用 RenderScene.snap，三条渲染链路都能显示。
   * 只有真实命中（debug ?snap、多边形已落顶点、当前 snap）才生成标记。
   */
  private snapMarkers(): readonly SnapMarker[] {
    const markers: SnapMarker[] = [...this.debugSnap];
    if (this.polygonDraft) {
      for (const point of this.polygonDraft.points) markers.push({kind: 'endpoint', point});
    }
    if (this.snap) markers.push({kind: this.snap.type, point: this.snap.point});
    return markers;
  }

  private addPolygonVertex(point: Point): void {
    const draft = this.polygonDraft;
    if (!draft) {
      // 双击收起后浏览器还会补发一次 pointerdown；短暂忽略，避免凭空开出单点草稿。
      if (performance.now() - this.lastPolygonFinish < POLYGON_REOPEN_GUARD_MS) return;
      this.options.notice.textContent = '';
      this.polygonDraft = {points: [point], hover: point};
      this.paint();
      return;
    }
    const nearFirst = boardScreenDistance(this.options.board, point, draft.points[0]) <= POLYGON_CLOSE_TOLERANCE_PX;
    // 已经有 3 个顶点时，点回起点优先解释为闭合；否则先报重复点。
    if (nearFirst && draft.points.length >= 3) {
      this.finishPolygon();
      return;
    }
    if (polygonHasPoint(draft.points, point)) {
      this.options.notice.textContent = '该位置已有顶点，请换一个位置。';
      this.render();
      return;
    }
    if (nearFirst) {
      this.polygonDraft = null;
      this.options.notice.textContent = polygonIssueText('too-few');
      this.render();
      return;
    }
    draft.points.push(point);
    draft.hover = point;
    this.paint();
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
    board.addEventListener('pointerleave', this.pointerLeave);
    for (const type of ['pointercancel', 'lostpointercapture'] as const) {
      board.addEventListener(type, this.pointerCancel);
    }
    board.addEventListener('wheel', this.wheel, {passive: false});
    // Safari 触控板 pinch 走 WebKit gesture 事件，不进入标准 wheel 通道。
    board.addEventListener('gesturestart', this.gestureStart as EventListener, {passive: false});
    board.addEventListener('gesturechange', this.gestureChange as EventListener, {passive: false});
  }

  private readonly wheel = (event: WheelEvent): void => {
    if (document.querySelector('dialog[open]')) return;
    event.preventDefault();
    const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 :
      event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? Math.max(1, this.options.board.clientHeight) : 1;
    const factor = wheelZoomFactor(event.deltaY * unit, event.ctrlKey);
    if (this.viewport.zoomAt(factor, event.clientX, event.clientY)) this.afterViewportChange();
  };

  private readonly gestureStart = (event: Event): void => {
    event.preventDefault();
    this.gestureZoom = this.viewport.zoom;
  };

  private readonly gestureChange = (event: Event): void => {
    event.preventDefault();
    const gesture = event as Event & {scale?: number; clientX?: number; clientY?: number};
    const rect = this.options.board.getBoundingClientRect();
    const scale = Number.isFinite(gesture.scale) ? gesture.scale! : 1;
    const x = gesture.clientX ?? rect.left + rect.width / 2;
    const y = gesture.clientY ?? rect.top + rect.height / 2;
    if (this.viewport.zoomToAt(this.gestureZoom * scale, x, y)) this.afterViewportChange();
  };

  private readonly pointerDown = (event: PointerEvent): void => {
    if (!event.isPrimary || (event.button !== 0 && event.button !== 1)) return;
    const board = this.options.board;
    // Space + 左键、或中键：只移动临时视口，不创建图元、不写历史。
    if (event.button === 1 || (this.spacePressed && event.button === 0)) {
      if (this.drawing) return;
      event.preventDefault();
      board.setPointerCapture(event.pointerId);
      this.panning = {id: event.pointerId, client: [event.clientX, event.clientY]};
      this.clearSnap();
      this.syncPanCursor();
      return;
    }
    this.interactionEpoch++;
    const raw = boardPoint(board, event);
    if (this.tool === 'eraser') {
      event.preventDefault();
      board.setPointerCapture(event.pointerId);
      this.clearSnap();
      const session = createEraseSession();
      eraseAlong(this.project, raw, raw, this.eraserRadiusWorld(), session);
      this.drawing = {mode: 'erase', id: event.pointerId, session, last: raw};
      this.paint();
      return;
    }
    // 选择拖动在 move 阶段按光标捕捉；画笔/圈选自由绘制保持原始轨迹，不做离散点吸附。
    const point = this.tool === 'select' || this.tool === 'pen' || this.tool === 'region' ||
      this.tool === 'text' ? raw : this.snapPoint(raw, NO_EXCLUDED_OBJECTS, event.altKey);
    if (!this.drawing && this.tool === 'select') {
      const handle = handleFromTarget(event.target as Element | null);
      if (handle && this.beginTransform(handle, event)) {
        event.preventDefault();
        return;
      }
    }
    if (this.tool === 'arc' && this.pendingArc) {
      event.preventDefault();
      this.finishArc(point);
      return;
    }
    if (this.tool === 'polygon') {
      event.preventDefault();
      this.addPolygonVertex(point);
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
          start: point, client: [event.clientX, event.clientY], moved: false,
          excluded: new Set(this.selectedShapes)};
        this.render();
        return;
      }
      const group = target?.closest<SVGGElement>('[data-id]');
      const mark = this.project.marks.find(item => item.id === group?.dataset.id);
      if (!mark) {
        // 触屏没有空格/中键：选择工具下在空白画布单指拖动即平移，触摸对象仍走选择/拖动。
        if (event.pointerType === 'touch') {
          event.preventDefault();
          board.setPointerCapture(event.pointerId);
          this.panning = {id: event.pointerId, client: [event.clientX, event.clientY]};
          this.clearSnap();
          this.syncPanCursor();
          return;
        }
        this.selection = null;
        this.selectedShapes = [];
        this.render();
        return;
      }
      event.preventDefault();
      this.selection = mark.id;
      this.selectedShapes = [];
      this.activeLayerId = mark.layerId;
      board.setPointerCapture(event.pointerId);
      this.drawing = {mode: 'move', id: event.pointerId, original: mark, mark, start: point,
        client: [event.clientX, event.clientY], moved: false, excluded: new Set([mark.id])};
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
      // 新建文字没有既有 id 可排除；先清掉吸附标记，避免锚点旁残留捕捉十字。
      this.clearSnap();
      const next = mark ?? createMarkForTool('text', point, this.brush, this.brushWidth,
        this.activeLayerId, this.customBrushColor, {textFontSize: this.textFontSize}) as TextMark;
      this.beginText(next);
      return;
    }
    const shapeType = toolShapeType(this.tool);
    if (shapeType) {
      board.setPointerCapture(event.pointerId);
      this.drawing = {mode: 'shape-create', id: event.pointerId,
        shape: createShape(shapeType, point, this.brush, this.brushWidth, this.activeLayerId, this.customBrushColor)};
      this.paint();
      return;
    }
    board.setPointerCapture(event.pointerId);
    this.drawing = {mode: 'mark-create', id: event.pointerId,
      mark: createMarkForTool(this.tool, point, this.brush, this.brushWidth,
        this.activeLayerId, this.customBrushColor,
        {arrowSize: this.arrowSize, textFontSize: this.textFontSize})};
    this.paint();
  };

  private readonly doubleClick = (event: MouseEvent): void => {
    if (this.tool === 'polygon') {
      this.finishPolygon();
      return;
    }
    if (this.tool !== 'select') return;
    const target = document.elementFromPoint(event.clientX, event.clientY);
    const group = target?.closest<SVGGElement>('[data-id]');
    const mark = this.project.marks.find(item => item.id === group?.dataset.id);
    if (!mark) return;
    if (mark.shape === 'text') this.beginText(mark);
    else this.onOpenMark?.(mark);
  };

  private readonly pointerMove = (event: PointerEvent): void => {
    if (this.panning && this.panning.id === event.pointerId) {
      const dx = event.clientX - this.panning.client[0];
      const dy = event.clientY - this.panning.client[1];
      this.panning.client = [event.clientX, event.clientY];
      // 平移同样改变 viewBox：文字内联框、浮动操作条与缩放读数都要重新投影。
      if (this.viewport.panBy(dx, dy)) this.afterViewportChange();
      return;
    }
    if (this.tool === 'polygon' && this.polygonDraft) {
      const raw = boardPoint(this.options.board, event);
      this.polygonDraft.hover = this.snapPoint(raw, NO_EXCLUDED_OBJECTS, event.altKey);
      this.paint();
      return;
    }
    if (this.pendingArc && this.tool === 'arc') {
      const raw = boardPoint(this.options.board, event);
      this.pendingArc.shape.points[1] = this.snapPoint(raw, NO_EXCLUDED_OBJECTS, event.altKey);
      this.paint();
      return;
    }
    if (this.drawing?.mode === 'erase' && this.drawing.id === event.pointerId) {
      const raw = boardPoint(this.options.board, event);
      if (eraseAlong(this.project, this.drawing.last, raw, this.eraserRadiusWorld(), this.drawing.session)) {
        this.paint();
      }
      this.drawing.last = raw;
      return;
    }
    if (!this.drawing || this.drawing.mode === 'text' || this.drawing.id !== event.pointerId) return;
    if (this.drawing.mode === 'transform') {
      this.updateTransform(event);
      this.paint();
      this.onPreview?.();
      return;
    }
    if (this.drawing.mode === 'move') {
      if (Math.hypot(event.clientX - this.drawing.client[0], event.clientY - this.drawing.client[1]) < 3 && !this.drawing.moved) return;
      const raw = boardPoint(this.options.board, event);
      const point = this.snapPoint(raw, this.drawing.excluded, event.altKey);
      const moving = this.drawing;
      moving.moved = true;
      moving.mark = translatedMark(moving.original, point[0] - moving.start[0], point[1] - moving.start[1]);
      this.onPreview?.();
    } else if (this.drawing.mode === 'shape-move') {
      if (Math.hypot(event.clientX - this.drawing.client[0], event.clientY - this.drawing.client[1]) < 3 && !this.drawing.moved) return;
      const raw = boardPoint(this.options.board, event);
      const point = this.snapPoint(raw, this.drawing.excluded, event.altKey);
      const moving = this.drawing;
      moving.moved = true;
      moving.shapes = moving.originals.map(shape =>
        translateShape(shape, point[0] - moving.start[0], point[1] - moving.start[1]));
      this.onPreview?.();
    } else if (this.drawing.mode === 'shape-create') {
      const point = this.shapeDraftPoint(event, this.drawing.shape);
      applyShapePoint(this.drawing.shape, point, event.shiftKey);
    } else if (this.drawing.mode === 'mark-create') {
      // 圈选是自由框选，按 US-05 AC5 不参与吸附；箭头等离散标注继续捕捉。
      const snap = this.drawing.mark.shape === 'region' ? (raw: Point) => raw :
        (raw: Point) => this.snapPoint(raw, NO_EXCLUDED_OBJECTS, event.altKey);
      applyStrokePoint(this.drawing.mark, event, this.options.board, snap);
    }
    this.paint();
  };

  /**
   * 图形绘制的终点：Shift 45°/正方形是硬约束，优先于实体捕捉；
   * 否则约束后的点会偏离已有点，用户看到捕捉标记却落不到目标。
   */
  private shapeDraftPoint(event: PointerEvent, shape: Shape): Point {
    const raw = boardPoint(this.options.board, event);
    if (event.shiftKey && (shape.type === 'line' || shape.type === 'rect')) {
      this.clearSnap();
      return raw;
    }
    return this.snapPoint(raw, NO_EXCLUDED_OBJECTS, event.altKey);
  }

  private readonly pointerUp = (event: PointerEvent): void => {
    if (this.panning && this.panning.id === event.pointerId) {
      this.panning = null;
      this.syncPanCursor();
      return;
    }
    if (!this.drawing || this.drawing.mode === 'text' || this.drawing.id !== event.pointerId) return;
    if (this.drawing.mode === 'erase') {
      const next = erasedProject(this.project, this.drawing.session);
      this.drawing = null;
      // 空擦不写 undo；有目标时整次拖动只 commit 一次。
      if (next) this.commit(next);
      else this.render();
      return;
    }
    if (this.drawing.mode === 'transform') {
      const {shapes, marks, moved} = this.drawing;
      this.drawing = null;
      this.clearSnap();
      // moved 由实际缩放比/旋转增量决定；没有真实变化时不写空 undo。
      if (!moved) {
        this.render();
        return;
      }
      const shapesById = new Map(shapes.map(shape => [shape.id, shape]));
      const marksById = new Map(marks.map(mark => [mark.id, mark]));
      // 一次指针手势只提交一次：预览期间从不调用 commit。
      this.commit({...this.project,
        shapes: this.project.shapes.map(shape => shapesById.get(shape.id) ?? shape),
        marks: this.project.marks.map(mark => marksById.get(mark.id) ?? mark)});
      return;
    }
    if (this.drawing.mode === 'move') {
      const {original, mark, moved} = this.drawing;
      this.drawing = null;
      if (moved) this.commit({...this.project, marks: this.project.marks.map(item => item.id === original.id ? mark : item)});
      else {
        this.clearSnap();
        this.render();
      }
      return;
    }
    if (this.drawing.mode === 'shape-move') {
      const {shapes, moved} = this.drawing;
      this.drawing = null;
      if (moved) {
        const movedById = new Map(shapes.map(shape => [shape.id, shape]));
        this.commit({...this.project, shapes: this.project.shapes.map(shape => movedById.get(shape.id) ?? shape)});
      } else {
        this.clearSnap();
        this.render();
      }
      return;
    }
    if (this.drawing.mode === 'shape-create') {
      const {shape} = this.drawing;
      applyShapePoint(shape, this.shapeDraftPoint(event, shape), event.shiftKey);
      this.drawing = null;
      if (shape.type === 'arc') {
        const [start, , end] = shape.points;
        if (Math.hypot(end[0] - start[0], end[1] - start[1]) >= 4) {
          this.pendingArc = {shape: {...shape, points: [start, end, end]}};
        }
        this.clearSnap();
        this.paint();
        return;
      }
      const wide = shape.type === 'rect' && Math.abs(shape.b[0] - shape.a[0]) >= 4 && Math.abs(shape.b[1] - shape.a[1]) >= 4;
      const long = shape.type === 'line' && Math.hypot(shape.points[1][0] - shape.points[0][0], shape.points[1][1] - shape.points[0][1]) >= 4;
      const round = shape.type === 'circle' && shape.radius >= 3;
      if (wide || long || round) this.addShape(shape);
      else {
        this.clearSnap();
        this.render();
      }
      return;
    }
    // 圈选自由绘制不吸附；画笔由 extendStroke 内部保持原始轨迹，箭头继续吸附。
    const snap = this.drawing.mark.shape === 'region' ? (raw: Point) => raw :
      (raw: Point) => this.snapPoint(raw, NO_EXCLUDED_OBJECTS, event.altKey);
    applyStrokePoint(this.drawing.mark, event, this.options.board, snap);
    let mark = this.drawing.mark;
    this.drawing = null;
    // 自动拟合只作用于自由手绘；其他工具生成的 Shape 完全不经过这里。
    if (mark.shape === 'pen') {
      mark = fitPenMark(mark, {mode: this.penFit, curve: this.penCurve, width: this.brushWidth});
    }
    const longEnough = mark.shape === 'region' || mark.shape === 'arrow'
      ? Math.hypot(mark.b[0] - mark.a[0], mark.b[1] - mark.a[1]) >= 4
      : false;
    if (mark.shape === 'pen' || longEnough) this.addMark(mark);
    else {
      this.clearSnap();
      this.render();
    }
  };

  private readonly pointerCancel = (event: PointerEvent): void => {
    if (this.panning?.id === event.pointerId) {
      this.panning = null;
      this.syncPanCursor();
      return;
    }
    if (!this.drawing || this.drawing.mode === 'text' || this.drawing.id !== event.pointerId) return;
    this.drawing = null;
    this.clearSnap();
    this.render();
  };

  /** 指针离开画布：保留未完成草稿，但不再显示上一位置的捕捉标记。 */
  private readonly pointerLeave = (): void => {
    if (this.drawing) return;
    if (this.clearSnap()) this.paint();
  };

  /** double-click 编辑回调由 UI 注入；避免 Editor 依赖编辑对话框 DOM。 */
  onOpenMark: ((mark: Mark) => void) | undefined;
}

function repaired(repair: {clamped: number; dropped: number; droppedObjects: number}): boolean {
  return repair.clamped > 0 || repair.dropped > 0 || repair.droppedObjects > 0;
}

/** randomUUID 需要安全上下文；普通局域网 http 打开时仍要能构造编辑器。 */
function newClipboardSessionId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function describeClipboard(content: ClipboardContent): string {
  const parts: string[] = [];
  if (content.shapes.length) parts.push(`${content.shapes.length} 个图形`);
  if (content.marks.length) parts.push(`${content.marks.length} 个标注`);
  return parts.join('、') || '0 个对象';
}

function sameSnap(a: SnapResult | null, b: SnapResult | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.type === b.type && a.entityId === b.entityId &&
    a.point[0] === b.point[0] && a.point[1] === b.point[1];
}

/**
 * 提交前的最后一道退化保护；夹取在 frame 层完成，这里按真实几何复核。
 * 最小尺寸取“产品下限”和“对象原始尺寸”的较小值，保证 2×2 的旧对象仍可编辑，
 * 但 10×4 的对象不会因为手柄 padding 被缩到 4 以下。
 */
function validTransformedShape(shape: Shape, original: Shape): boolean {
  if (!Number.isFinite(shape.strokeWidth) || shape.strokeWidth <= 0) return false;
  switch (shape.type) {
    case 'rect': {
      // rect.a/b 始终是局部半轴端点，rotation 单独存储；shapeSize 得到的就是局部宽高，
      // 不能改读世界 AABB，否则旋转 45° 的细长矩形会被误判为“仍然够大”。
      const [width, height] = shapeSize(shape);
      const [originalWidth, originalHeight] = shapeSize(original);
      return width >= Math.min(4, originalWidth) - 1e-6 &&
        height >= Math.min(4, originalHeight) - 1e-6;
    }
    case 'circle': {
      // 旧草稿可能有半径 <1 的圆；下限不能高于对象原始半径，否则无法平滑缩放。
      const minRadius = Math.min(1, original.type === 'circle' ? Math.abs(original.radius) : 1);
      return Number.isFinite(shape.radius) && shape.radius >= minRadius - 1e-6;
    }
    case 'arc': {
      const points = shape.points;
      if (points.length !== 3) return false;
      const chord = Math.hypot(points[2][0] - points[0][0], points[2][1] - points[0][1]);
      return chord >= Math.min(4, arcChord(original)) - 1e-6 && arcCircle(points) !== null;
    }
    case 'line': {
      const length = Math.hypot(shape.points[1][0] - shape.points[0][0],
        shape.points[1][1] - shape.points[0][1]);
      return length >= Math.min(2, lineLength(original)) - 1e-6;
    }
    case 'path': {
      const [width, height] = shapeSize(shape);
      const [originalWidth, originalHeight] = shapeSize(original);
      return width >= Math.min(4, originalWidth) - 1e-6 &&
        height >= Math.min(4, originalHeight) - 1e-6;
    }
  }
}

function shapeSize(shape: Shape): Point {
  // 矩形 a/b 是局部框端点（rotation 独立），路径没有旋转，因此这里两者都是局部宽高。
  if (shape.type === 'rect') return [Math.abs(shape.b[0] - shape.a[0]), Math.abs(shape.b[1] - shape.a[1])];
  if (shape.type !== 'path') return [0, 0];
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  // 大路径逐环遍历，避免每次 pointermove 再 flat(2) 出一份 20 万点数组。
  for (const polygon of shape.polygons) {
    for (const ring of polygon) {
      for (const [x, y] of ring) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }
  return Number.isFinite(minX) ? [maxX - minX, maxY - minY] : [0, 0];
}

function arcChord(shape: Shape): number {
  if (shape.type !== 'arc') return 0;
  return Math.hypot(shape.points[2][0] - shape.points[0][0], shape.points[2][1] - shape.points[0][1]);
}

function lineLength(shape: Shape): number {
  if (shape.type !== 'line') return 0;
  return Math.hypot(shape.points[1][0] - shape.points[0][0], shape.points[1][1] - shape.points[0][1]);
}
