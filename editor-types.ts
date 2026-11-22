import type {MarkKind} from './project.ts';

export type Tool = 'select' | 'line' | 'rect' | 'circle' | 'arc' | 'pen' | 'region' | 'arrow' | 'text';
export type Brush = 'auto' | 'custom' | MarkKind;

export const TOOL_MESSAGES: Record<Tool, string> = {
  select: '拖动对象移动，双击编辑标注', pen: '在画板上拖动绘制',
  line: '拖动绘制直线，按住 Shift 吸附 45°', rect: '拖动绘制矩形，按住 Shift 画正方形',
  circle: '从圆心向外拖动确定半径', arc: '先拖出弦，再移动并点击确定弧的弯向',
  region: '从区域的一角拖到对角', arrow: '从箭尾拖到受力位置', text: '点击画布输入文字'
};

export interface EditorOptions {
  board: SVGSVGElement;
  status: HTMLElement;
  notice: HTMLElement;
  textInput: HTMLInputElement;
  /** 项目/选择变化后刷新工具栏、图层面板、标注卡片等 DOM 投影。 */
  onChange?: () => void;
  onToolChange?: (tool: Tool) => void;
}
