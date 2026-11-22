import {booleanShapes, canBoolean, newShape, shapePointCount} from './geometry.ts';
import type {BooleanOperation, Shape} from './geometry.ts';
import {ensureGeometryKernel, GeometryKernelNotReadyError} from './kernel.ts';
import type {Project} from './project.ts';
import {withTimeout} from './timeout.ts';

export interface BooleanSelectionHost {
  project: Project;
  selectedShapes: string[];
  notice: HTMLElement;
  revision: number;
  beginInteraction(): number;
  isInterrupted(epoch: number, revision: number): boolean;
  commit(next: Project): void;
  setSelection(id: string | null): void;
  setSelectedShapes(ids: string[]): void;
  refresh(): void;
}

/** 主线程同步布尔的安全上限；超过时宁可提示用户，也不冻结交互。 */
const MAX_BOOLEAN_INPUT_POINTS = 40000;

/** 布尔运算涉及 Wasm 等待与交互令牌，独立于指针状态机，避免 Editor 继续膨胀。 */
export async function booleanSelection(host: BooleanSelectionHost, operation: BooleanOperation): Promise<void> {
  const shapes = host.selectedShapes.map(id => host.project.shapes.find(shape => shape.id === id))
    .filter(Boolean) as Shape[];
  if (!canBoolean(shapes)) {
    host.notice.textContent = '布尔操作需要至少两个闭合图形：矩形、圆或已有的布尔结果。';
    return;
  }
  if (shapes.reduce((total, shape) => total + shapePointCount(shape), 0) > MAX_BOOLEAN_INPUT_POINTS) {
    host.notice.textContent = '选中的图形过于复杂（超过 4 万个顶点），请减少图形或简化后再试。';
    return;
  }
  const startRevision = host.revision;
  const epoch = host.beginInteraction();
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('[data-boolean]')];
  for (const button of buttons) button.disabled = true;
  host.notice.textContent = '正在计算布尔结果…';
  try {
    await withTimeout(ensureGeometryKernel(), 8000, '几何内核加载超时');
    // 等待内核期间用户可能已经开始拖动；revision 尚未变化，必须靠交互令牌拦截，
    // 否则旧 originals 会在 pointerup 时覆盖刚提交的布尔结果。
    if (host.isInterrupted(epoch, startRevision)) {
      host.notice.textContent = '画布已变化，布尔操作已取消。';
      return;
    }
    const output = booleanShapes(operation, shapes);
    if (!output) {
      host.notice.textContent = '这些图形没有产生有效区域，请检查是否重叠。';
      return;
    }
    const source = shapes[0];
    const shape = newShape('path', {...output, layerId: source.layerId, color: source.color,
      strokeWidth: source.strokeWidth});
    const replaced = new Set(shapes.map(item => item.id));
    host.setSelectedShapes([shape.id]);
    host.setSelection(null);
    host.notice.textContent = operation === 'subtract' ? '已用先选中的图形减去其余图形。' : '已生成布尔图形。';
    host.commit({...host.project, shapes: [...host.project.shapes.filter(item => !replaced.has(item.id)), shape]});
  } catch (error) {
    console.error('布尔运算失败。', error);
    host.notice.textContent = error instanceof GeometryKernelNotReadyError
      ? '几何内核尚未就绪，请稍后重试。'
      : '几何内核加载或计算失败，请刷新页面后重试。';
  } finally {
    host.refresh();
  }
}
