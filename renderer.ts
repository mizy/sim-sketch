import type {Point, Polygon} from './geometry.ts';
import type {Rgba} from './theme.ts';

export type RendererBackend = 'webgpu' | 'canvas2d' | 'svg';

export interface RenderViewport {
  /** 世界坐标 viewBox。 */
  x: number;
  y: number;
  width: number;
  height: number;
  cssWidth: number;
  cssHeight: number;
  dpr: number;
  /** CSS 像素 / 世界单位，用于屏幕恒定尺寸（捕捉标记、命中阈值）。 */
  pixelsPerWorldUnit: number;
}

export interface GridSpec {
  spacing: number;
  radius: number;
  /** 网格点在 world 坐标中的相位偏移。 */
  origin: Point;
  background: Rgba;
  dot: Rgba;
}

export interface ReferenceSpec {
  layerId: string;
  source: string;
}

export type SnapKind = 'endpoint' | 'midpoint' | 'center' | 'quadrant' | 'intersection' | 'nearest' | 'grid';

export interface SnapMarker {
  kind: SnapKind;
  point: Point;
}

export interface StrokePrimitive {
  kind: 'stroke';
  layerId: string;
  points: readonly Point[];
  color: Rgba;
  width: number;
  closed?: boolean;
  dash?: readonly [number, number];
}

export interface EllipsePrimitive {
  kind: 'ellipse';
  layerId: string;
  center: Point;
  radii: Point;
  color: Rgba;
  width: number;
  fill?: number;
  dash?: boolean;
}

export interface FillPrimitive {
  kind: 'fill';
  layerId: string;
  polygons: readonly Polygon[];
  color: Rgba;
  opacity: number;
}

export interface MarkerPrimitive {
  kind: 'marker';
  layerId: string;
  marker: SnapMarker;
  color: Rgba;
}

export type RenderPrimitive = StrokePrimitive | EllipsePrimitive | FillPrimitive | MarkerPrimitive;

export interface RenderLayer {
  id: string;
  opacity: number;
  primitives: RenderPrimitive[];
}

export interface RenderScene {
  revision: number;
  viewport: RenderViewport;
  background: GridSpec;
  reference: ReferenceSpec | null;
  layers: RenderLayer[];
  /** 正在绘制/拖动的图元，渲染时并入所属图层。 */
  temporary: RenderPrimitive[];
  snap: readonly SnapMarker[];
}

export interface RendererOptions {
  /** 运行期 device lost / draw 失败时通知 Host 回退。 */
  onError?: (error: unknown) => void;
  /** 异步资源（参考图）就绪后请求 Host 重画。 */
  onInvalidate?: () => void;
  /** QA/导出：允许从 WebGPU swapchain 复制当前帧；正常渲染不开启。 */
  capture?: boolean;
}

export interface SketchRenderer {
  readonly backend: RendererBackend;
  resize(width: number, height: number, dpr: number): void;
  /** 同步消费 RenderScene；不得读取项目状态或生成文字，后端可使用自身的 canvas/SVG 资源。 */
  draw(scene: RenderScene): void;
  /** 清空几何显示层。SVG 从回退切到 GPU 后需要移除旧 path；canvas 后端无需清理。 */
  clearGeometry(): void;
  destroy(): void;
}
