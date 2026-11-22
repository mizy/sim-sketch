import type {Point, Polygon} from './geometry.ts';
import {GeometryKernelNotReadyError, tessellatePolygons} from './kernel.ts';
import type {Tessellation} from './kernel.ts';
import type {RenderPrimitive} from './renderer.ts';
import type {Rgba} from './theme.ts';


/** geom(4) + style(4) + color(4) + dash(2) + depth(1)。必须与 webgpu-shaders.ts 的 stride 同步。 */
export const INSTANCE_FLOATS = 15;

export interface GpuStrokeOp {
  kind: 'stroke';
  first: number;
  count: number;
  /** 图层内绘制次序映射到深度，晚绘制的图元更靠近相机。 */
  depth: number;
  /** 半透明图元必须按 painter 顺序绘制且不写深度。 */
  translucent: boolean;
}

export interface GpuFillOp {
  kind: 'fill';
  polygons: readonly Polygon[];
  color: Rgba;
  opacity: number;
  depth: number;
  translucent: boolean;
}

export type GpuDrawOp = GpuStrokeOp | GpuFillOp;

export interface GpuPacked {
  instances: Float32Array<ArrayBuffer>;
  ops: GpuDrawOp[];
}

type DashPattern = readonly [number, number];

function pushSegment(items: number[], from: Point, to: Point, width: number, color: Rgba,
  dash?: DashPattern): void {
  items.push(from[0], from[1], to[0], to[1], width, 0, 0, dash ? 1 : 0, ...color, ...(dash ?? [0, 0]), 0);
}

function pushEllipse(items: number[], center: Point, radii: Point, width: number, color: Rgba,
  fill = 0, dash = false): void {
  // SVG/Canvas2D 的虚线椭圆统一使用 9/5；WebGPU 通过实例数据读取同一 pattern。
  const pattern: DashPattern = dash ? [9, 5] : [0, 0];
  items.push(center[0], center[1], Math.max(.1, radii[0]), Math.max(.1, radii[1]), width, 1, fill,
    dash ? 1 : 0, ...color, ...pattern, 0);
}

function pushMarker(items: number[], point: Point, ppu: number, color: Rgba): void {
  const size = 7 / Math.max(ppu, .01);
  const halo = 3.5 / Math.max(ppu, .01);
  const line = 1.8 / Math.max(ppu, .01);
  const white: Rgba = [1, 1, 1, 1];
  for (const [width, stroke] of [[halo, white], [line, color]] as const) {
    pushSegment(items, [point[0] - size, point[1]], [point[0] + size, point[1]], width, stroke);
    pushSegment(items, [point[0], point[1] - size], [point[0], point[1] + size], width, stroke);
    pushEllipse(items, point, [size * .62, size * .62], width, stroke);
  }
}

/**
 * 把同一图层的图元打包成 stroke 实例缓冲与有序 draw op。
 * 每个实例带一个按绘制次序递减的深度，渲染时用深度测试恢复跨 fill/stroke 的
 * painter 次序。按透明度断批：不透明批次写深度，半透明批次由渲染器按 painter
 * 顺序、不写深度地绘制。深度必须逐实例分配，否则等深度的后绘制本体会被丢弃。
 */
export function packPrimitives(primitives: readonly RenderPrimitive[], pixelsPerWorldUnit: number): GpuPacked {
  const instances: number[] = [];
  const ops: GpuDrawOp[] = [];
  let first = 0;
  let openTranslucent: boolean | null = null;

  const flush = (): void => {
    if (openTranslucent === null) return;
    const count = instances.length / INSTANCE_FLOATS - first;
    if (count > 0) ops.push({kind: 'stroke', first, count, depth: 0, translucent: openTranslucent});
    first = instances.length / INSTANCE_FLOATS;
    openTranslucent = null;
  };

  /** 连续且透明度一致的描边实例合成一个 draw；透明度切换时必须断批。 */
  const openRun = (translucent: boolean): void => {
    if (openTranslucent === translucent) return;
    flush();
    openTranslucent = translucent;
  };

  for (const primitive of primitives) {
    switch (primitive.kind) {
      case 'stroke': {
        const points = primitive.points;
        if (points.length < 2) break;
        openRun(primitive.color[3] < .999);
        const last = primitive.closed ? points.length : points.length - 1;
        for (let index = 0; index < last; index++) {
          pushSegment(instances, points[index], points[(index + 1) % points.length],
            primitive.width, primitive.color, primitive.dash);
        }
        break;
      }
      case 'ellipse': {
        const fillAlpha = (primitive.fill ?? 0) * primitive.color[3];
        openRun(primitive.color[3] < .999 || (fillAlpha > 0 && fillAlpha < .999));
        pushEllipse(instances, primitive.center, primitive.radii, primitive.width, primitive.color,
          primitive.fill ?? 0, primitive.dash);
        break;
      }
      case 'fill':
        flush();
        ops.push({kind: 'fill', polygons: primitive.polygons, color: primitive.color,
          opacity: primitive.opacity, depth: 0, translucent: primitive.opacity * primitive.color[3] < .999});
        break;
      case 'marker':
        openRun(primitive.color[3] < .999);
        pushMarker(instances, primitive.marker.point, pixelsPerWorldUnit, primitive.color);
        break;
    }
  }
  flush();
  assignDepths(ops, instances);
  return {instances: new Float32Array(instances), ops};
}

/**
 * 晚绘制的图元深度更小（更靠近相机）；每层清空深度缓冲后重新从 1 开始。
 * 深度单位是「一个填充 op 或一个 stroke 实例」：同一批次内的每个实例也各自
 * 占一个单位，保证后绘制者严格靠前。
 */
function assignDepths(ops: GpuDrawOp[], instances: number[]): void {
  const total = ops.reduce((sum, op) => sum + (op.kind === 'stroke' ? op.count : 1), 0);
  let unit = 0;
  const nextDepth = (): number => 1 - ++unit / (total + 1);
  for (const op of ops) {
    if (op.kind !== 'stroke') {
      op.depth = nextDepth();
      continue;
    }
    for (let item = op.first; item < op.first + op.count; item++) {
      const depth = nextDepth();
      // stroke op 的 depth 记录首实例，供测试与调试读取；实例自身携带真实深度。
      if (item === op.first) op.depth = depth;
      instances[item * INSTANCE_FLOATS + INSTANCE_FLOATS - 1] = depth;
    }
  }
}

export type FillTessellator = (polygons: readonly Polygon[]) => Tessellation;

/**
 * 三角化按多边形数组身份缓存：拖动单个图元时只重算它自己，
 * 其余未变化的矩形/布尔结果继续复用顶点与索引。
 */
const tessellationCache = new WeakMap<readonly Polygon[], Map<FillTessellator, Tessellation>>();

function cachedTessellation(polygons: readonly Polygon[], tessellate: FillTessellator): Tessellation {
  let byTessellator = tessellationCache.get(polygons);
  if (!byTessellator) {
    byTessellator = new Map();
    tessellationCache.set(polygons, byTessellator);
  }
  const cached = byTessellator.get(tessellate);
  if (cached) return cached;
  const result = tessellate(polygons);
  byTessellator.set(tessellate, result);
  return result;
}

export interface FillRange {
  first: number;
  count: number;
  vertexFirst: number;
  vertexCount: number;
}

export interface FillGeometry {
  /** 已展开为 triangle-list 的世界坐标顶点，供测试核对 parity/面积。 */
  triangles: Float32Array<ArrayBuffer>;
  /** x, y, premultiplied rgba, depth；每个填充 op 一段连续顶点。 */
  vertices: Float32Array<ArrayBuffer>;
  ranges: Map<GpuFillOp, FillRange>;
  /** 首个填充在三角化时内核尚未就绪，Host 应在内核加载完成后重画。 */
  needsKernel: boolean;
}

/**
 * 用 Rust/Wasm 的 ear-clipping 生成无重叠三角形，直接带颜色提交给 WebGPU。
 * 三角扇会为凹多边形生成越界重叠三角形，破坏 even-odd parity，因此不能再用。
 */
export function buildFillGeometry(ops: readonly GpuDrawOp[],
  tessellate: FillTessellator = tessellatePolygons): FillGeometry {
  const triangles: number[] = [];
  const vertices: number[] = [];
  const ranges = new Map<GpuFillOp, FillRange>();
  let needsKernel = false;
  for (const op of ops) {
    if (op.kind !== 'fill') continue;
    const first = triangles.length / 2;
    const vertexFirst = vertices.length / 7;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const polygon of op.polygons) for (const ring of polygon) {
      for (const [x, y] of ring) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY)) continue;
    try {
      const {positions, indices} = cachedTessellation(op.polygons, tessellate);
      const alpha = op.opacity * op.color[3];
      const red = op.color[0] * alpha;
      const green = op.color[1] * alpha;
      const blue = op.color[2] * alpha;
      for (const index of indices) {
        if (!Number.isInteger(index) || index < 0 || index * 2 + 1 >= positions.length) {
          throw new Error(`三角化返回越界索引：${index}（顶点数 ${positions.length / 2}）`);
        }
        const x = positions[index * 2];
        const y = positions[index * 2 + 1];
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          throw new Error(`三角化返回非法顶点：${x},${y}`);
        }
        triangles.push(x, y);
        vertices.push(x, y, red, green, blue, alpha, op.depth);
      }
    } catch (error) {
      // 内核尚未就绪可以等预热完成后重画；其余异常（截断/越界/内核 bug）必须
      // 上抛给 WebGpuRenderer.draw，由 Host 回退到仍能正常填充的后端。
      if (!(error instanceof GeometryKernelNotReadyError)) throw error;
      needsKernel = true;
    }
    if (triangles.length === first) continue;
    ranges.set(op, {first, count: triangles.length / 2 - first,
      vertexFirst, vertexCount: vertices.length / 7 - vertexFirst});
  }
  return {triangles: new Float32Array(triangles), vertices: new Float32Array(vertices), ranges, needsKernel};
}
