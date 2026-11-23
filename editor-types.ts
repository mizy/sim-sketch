import type {MarkKind} from './project.ts';
import type {SnapResult} from './snap.ts';

export type Tool = 'select' | 'line' | 'rect' | 'circle' | 'arc' | 'polygon' | 'pen' | 'region' | 'arrow' | 'text' | 'eraser';
export type Brush = 'auto' | 'custom' | MarkKind;

export const TOOL_MESSAGES: Record<Tool, string> = {
  select: '拖动对象移动；拖 8 个局部轴手柄缩放，Shift 等比；拖旋转柄旋转，Esc 取消', pen: '在画板上拖动绘制',
  line: '拖动绘制直线，按住 Shift 吸附 45°', rect: '拖动绘制矩形，按住 Shift 画正方形',
  circle: '从圆心向外拖动确定半径', arc: '先拖出弦，再移动并点击确定弧的弯向',
  polygon: '逐点点击添加顶点，双击 / Enter / 点回起点闭合，Esc 取消',
  region: '从区域的一角拖到对角', arrow: '从箭尾拖到受力位置', text: '点击画布输入文字',
  eraser: '按住拖动擦除整条笔画/标注；一次拖动一步撤销，空擦不写历史'
};

export interface EditorOptions {
  board: SVGSVGElement;
  status: HTMLElement;
  notice: HTMLElement;
  textInput: HTMLInputElement;
  /** 项目/选择变化后刷新工具栏、图层面板、标注卡片等 DOM 投影。 */
  onChange?: () => void;
  onToolChange?: (tool: Tool) => void;
  /** 视口缩放/适配后刷新缩放读数；视口不进入项目，因此不触发 onChange。 */
  onViewportChange?: (zoom: number) => void;
  /** 捕捉命中/解除时刷新类型标记；null 表示未命中或已关闭。 */
  onSnapChange?: (snap: SnapResult | null) => void;
  /** 变换/移动预览时只调整浮动操作条位置，不重建整份 UI。 */
  onPreview?: () => void;
}
