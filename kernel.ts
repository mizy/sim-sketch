import type {BooleanOperation, Point, Polygon} from './geometry.ts';

/**
 * Wasm geometry-kernel facade.
 *
 * The rest of the app talks to this module only; the legacy vendored
 * polygon-clipping bundle has been removed. The kernel is stateless and
 * instantiated lazily so it never blocks first paint.
 */

const ABI_VERSION = 2;
const WASM_URL = new URL('./wasm/pkg/sim_sketch_geometry.wasm', import.meta.url);

const OPERATION_CODES: Record<BooleanOperation, number> = {
  union: 0,
  intersect: 1,
  subtract: 2
};

/** `geometry_op` op codes; must stay in sync with `wasm/src/lib.rs`. */
const GEOMETRY_OPS = {
  tessellate: 0,
  circle: 1,
  arc: 2,
  cubic: 3,
  intersections: 4,
  trim: 5,
  extend: 6,
  offset: 7,
  fillet: 8
} as const;

interface KernelExports {
  memory: WebAssembly.Memory;
  kernel_abi_version(): number;
  alloc_f64(length: number): number;
  dealloc_f64(pointer: number, length: number): void;
  boolean_rings(operation: number, pointer: number, length: number): bigint;
  geometry_op(operation: number, pointer: number, length: number): bigint;
}

export interface Tessellation {
  positions: Float32Array;
  indices: Uint32Array;
}

export interface PolylineIntersection {
  point: Point;
  aSegment: number;
  bSegment: number;
  t: number;
  u: number;
}

export interface PolylineEdit {
  points: Point[];
  changed: boolean;
}

export interface OffsetOptions {
  closed?: boolean;
  join?: 'miter' | 'round';
  miterLimit?: number;
}

export interface FilletOptions {
  /** Zero-based interior vertex; omitted means every corner. */
  corner?: number;
  /** Arc segments per corner; omitted uses an adaptive 10° step. */
  segments?: number;
  /** Treat the polyline as a ring so the first/last vertex is filleted too. */
  closed?: boolean;
}

export class GeometryKernelNotReadyError extends Error {
  constructor() {
    super('几何内核尚未初始化');
    this.name = 'GeometryKernelNotReadyError';
  }
}

let kernel: KernelExports | null = null;
let pending: Promise<void> | null = null;

/**
 * Instantiate the kernel once. Tests pass the checked-in `.wasm` bytes while
 * the browser uses the Vite-emitted asset URL.
 */
export function initGeometryKernel(source: string | URL | Response | BufferSource = WASM_URL): Promise<void> {
  if (kernel) return Promise.resolve();
  if (!pending) {
    pending = loadKernel(source)
      .then(exports => {
        const abi = exports.kernel_abi_version();
        if (abi !== ABI_VERSION) {
          throw new Error(`几何内核 ABI 不匹配：需要 ${ABI_VERSION}，实际 ${abi}`);
        }
        kernel = exports;
      })
      .catch(error => {
        kernel = null;
        pending = null;
        throw error;
      });
  }
  return pending;
}

/** Load the browser asset on demand (used before a boolean operation). */
export function ensureGeometryKernel(): Promise<void> {
  return initGeometryKernel(WASM_URL);
}

/**
 * Synchronous boolean entry point. `ensureGeometryKernel()` must have resolved
 * first; callers catch `GeometryKernelNotReadyError` to show a loading state.
 */
export function booleanPolygons(operation: BooleanOperation, shapes: readonly Polygon[][]): Polygon[] {
  const data = callKernel(OPERATION_CODES[operation], encodeShapes(shapes));
  return decodePolygons(data);
}

/**
 * Triangulate closed polygons (outer ring + holes) into GPU-ready buffers.
 * The triangles are CCW in sketch space and share one position buffer.
 */
export function tessellatePolygons(polygons: readonly Polygon[]): Tessellation {
  if (!polygons.length) return {positions: new Float32Array(), indices: new Uint32Array()};
  const data = callGeometry(GEOMETRY_OPS.tessellate, encodeShapes([polygons]));
  let cursor = 0;
  const vertexCount = readCount(data, cursor++);
  if (vertexCount * 2 + cursor > data.length) throw new Error('几何内核返回了截断的顶点缓冲');
  const positions = new Float32Array(vertexCount * 2);
  for (let index = 0; index < positions.length; index++) positions[index] = data[cursor++];
  const indexCount = readCount(data, cursor++);
  if (cursor + indexCount > data.length) throw new Error('几何内核返回了截断的索引缓冲');
  const indices = new Uint32Array(indexCount);
  for (let index = 0; index < indexCount; index++) {
    const value = data[cursor++];
    if (!Number.isInteger(value) || value < 0 || value >= vertexCount) {
      throw new Error('几何内核返回了非法顶点索引');
    }
    indices[index] = value;
  }
  return {positions, indices};
}

/** Flatten a circle using the legacy `circlePoints()` segment rule by default. */
export function flattenCircle(center: Point, radius: number, segments?: number): Point[] {
  const count = segments ?? Math.max(32, Math.min(160, Math.ceil(2 * Math.PI * Math.abs(radius) / 3)));
  return readPolyline(callGeometry(GEOMETRY_OPS.circle, new Float64Array([center[0], center[1], radius, count])));
}

/** Flatten a three-point arc, matching `arcPoints()` segment density. */
export function flattenArc(points: readonly Point[], segments?: number): Point[] {
  if (points.length < 3) return points.map(point => [...point] as Point);
  const [start, through, end] = points;
  const count = segments ?? Math.max(12, Math.min(160, Math.ceil(arcSpan(start, through, end) / (Math.PI * 2) * 96)));
  return readPolyline(callGeometry(GEOMETRY_OPS.arc,
    new Float64Array([...start, ...through, ...end, count])));
}

/** Adaptive cubic Bézier flattening; tolerance is in sketch units. */
export function flattenCubicBezier(p0: Point, c1: Point, c2: Point, p1: Point, tolerance = 0.25): Point[] {
  return readPolyline(callGeometry(GEOMETRY_OPS.cubic,
    new Float64Array([...p0, ...c1, ...c2, ...p1, tolerance])));
}

/** All intersections between two open polylines, ordered along the first. */
export function polylineIntersections(a: readonly Point[], b: readonly Point[]): PolylineIntersection[] {
  const data = callGeometry(GEOMETRY_OPS.intersections,
    new Float64Array([...encodeSegments(a), ...encodeSegments(b)]));
  let cursor = 0;
  const count = readCount(data, cursor++);
  const hits: PolylineIntersection[] = [];
  for (let index = 0; index < count; index++) {
    const x = data[cursor++];
    const y = data[cursor++];
    const aSegment = readCount(data, cursor++);
    const bSegment = readCount(data, cursor++);
    const t = data[cursor++];
    const u = data[cursor++];
    if (![x, y, t, u].every(Number.isFinite)) throw new Error('几何内核返回了非法交点');
    hits.push({point: [x, y], aSegment, bSegment, t, u});
  }
  return hits;
}

/**
 * Trim an open polyline at its first/last crossing with `boundary`.
 * `keep: 'start'` keeps the side from the first point to the cut.
 */
export function trimPolyline(points: readonly Point[], boundary: readonly Point[],
  keep: 'start' | 'end' = 'start'): PolylineEdit {
  const data = callGeometry(GEOMETRY_OPS.trim, new Float64Array([
    ...encodePoints(points), ...encodePoints(boundary), keep === 'start' ? 1 : 0
  ]));
  return readEdit(data);
}

/**
 * Extend one end along its last segment direction until it hits `boundary`.
 * Without a hit, `maxDistance > 0` extends by that distance instead.
 */
export function extendPolyline(points: readonly Point[], boundary: readonly Point[],
  end: 'start' | 'end' = 'end', maxDistance = 0): PolylineEdit {
  const data = callGeometry(GEOMETRY_OPS.extend, new Float64Array([
    ...encodePoints(points), ...encodePoints(boundary), end === 'start' ? 0 : 1, maxDistance
  ]));
  return readEdit(data);
}

/**
 * Offset an open polyline or closed ring. Positive distance is the left-hand
 * normal for open paths; closed rings grow outward for positive distances
 * regardless of input orientation (the kernel normalizes the ring).
 */
export function offsetPolyline(points: readonly Point[], distance: number,
  options: OffsetOptions = {}): Point[] {
  const data = callGeometry(GEOMETRY_OPS.offset, new Float64Array([
    ...encodePoints(points), distance, options.closed ? 1 : 0,
    options.join === 'round' ? 1 : 0, options.miterLimit ?? 4
  ]));
  return readPolyline(data);
}

/** Replace one or all polyline corners with a tangent arc. */
export function filletPolyline(points: readonly Point[], radius: number,
  options: FilletOptions = {}): Point[] {
  const data = callGeometry(GEOMETRY_OPS.fillet, new Float64Array([
    ...encodePoints(points), radius, options.corner ?? -1, options.segments ?? 0,
    options.closed ? 1 : 0
  ]));
  return readPolyline(data);
}

async function loadKernel(source: string | URL | Response | BufferSource): Promise<KernelExports> {
  const bytes = await readSource(source);
  const {instance} = await WebAssembly.instantiate(bytes, {});
  const exports = instance.exports as unknown as KernelExports;
  if (!exports.memory || typeof exports.boolean_rings !== 'function' ||
    typeof exports.geometry_op !== 'function') {
    throw new Error('几何内核导出缺失');
  }
  return exports;
}

async function readSource(source: string | URL | Response | BufferSource): Promise<BufferSource> {
  if (typeof source === 'string' || source instanceof URL) {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`几何内核加载失败：HTTP ${response.status}`);
    return response.arrayBuffer();
  }
  if (typeof Response !== 'undefined' && source instanceof Response) {
    return source.arrayBuffer();
  }
  return source as BufferSource;
}

function callKernel(operation: number, input: Float64Array): Float64Array {
  if (!kernel) throw new GeometryKernelNotReadyError();
  const pointer = kernel.alloc_f64(input.length);
  if (!pointer && input.length) throw new Error('几何内核内存分配失败');
  try {
    // `memory.buffer` can detach after growth; always take a fresh view.
    new Float64Array(kernel.memory.buffer, pointer, input.length).set(input);
    return readRaw(kernel.boolean_rings(operation, pointer, input.length));
  } finally {
    if (pointer) kernel.dealloc_f64(pointer, input.length);
  }
}

function callGeometry(operation: number, input: Float64Array): Float64Array {
  if (!kernel) throw new GeometryKernelNotReadyError();
  const pointer = kernel.alloc_f64(input.length);
  if (!pointer && input.length) throw new Error('几何内核内存分配失败');
  try {
    new Float64Array(kernel.memory.buffer, pointer, input.length).set(input);
    return readRaw(kernel.geometry_op(operation, pointer, input.length));
  } finally {
    if (pointer) kernel.dealloc_f64(pointer, input.length);
  }
}

function readRaw(packed: bigint): Float64Array {
  if (!kernel) return new Float64Array();
  const pointer = Number(packed & 0xffffffffn);
  const length = Number(packed >> 32n);
  if (!pointer || !length) return new Float64Array();
  try {
    return new Float64Array(kernel.memory.buffer, pointer, length).slice();
  } finally {
    kernel.dealloc_f64(pointer, length);
  }
}

function readPolyline(data: Float64Array): Point[] {
  if (!data.length) return [];
  let cursor = 0;
  const count = readCount(data, cursor++);
  if (cursor + count * 2 > data.length) throw new Error('几何内核返回了截断的折线');
  const points: Point[] = [];
  for (let index = 0; index < count; index++) {
    const x = data[cursor++];
    const y = data[cursor++];
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('几何内核返回了非法坐标');
    points.push([x, y]);
  }
  return points;
}

function readEdit(data: Float64Array): PolylineEdit {
  if (!data.length) return {changed: false, points: []};
  let cursor = 0;
  const changed = data[cursor++] === 1;
  return {changed, points: readPolylineAt(data, cursor)};
}

function readPolylineAt(data: Float64Array, start: number): Point[] {
  if (start >= data.length) return [];
  let cursor = start;
  const count = readCount(data, cursor++);
  if (cursor + count * 2 > data.length) throw new Error('几何内核返回了截断的折线');
  const points: Point[] = [];
  for (let index = 0; index < count; index++) {
    const x = data[cursor++];
    const y = data[cursor++];
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('几何内核返回了非法坐标');
    points.push([x, y]);
  }
  return points;
}

function encodePoints(points: readonly Point[]): number[] {
  return [points.length, ...points.flatMap(([x, y]) => [x, y])];
}

function encodeSegments(points: readonly Point[]): number[] {
  const count = Math.max(0, points.length - 1);
  const data = [count];
  for (let index = 0; index < count; index++) {
    data.push(...points[index], ...points[index + 1]);
  }
  return data;
}

/** Span of the through-arc, mirroring `arcCircle()` in geometry.ts. */
function arcSpan(a: Point, b: Point, c: Point): number {
  const divisor = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(divisor) < 1e-6) return Math.PI / 2;
  const a2 = a[0] * a[0] + a[1] * a[1];
  const b2 = b[0] * b[0] + b[1] * b[1];
  const c2 = c[0] * c[0] + c[1] * c[1];
  const center: Point = [
    (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / divisor,
    (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / divisor
  ];
  const turn = (value: number): number => (value % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
  const start = Math.atan2(a[1] - center[1], a[0] - center[0]);
  const through = Math.atan2(b[1] - center[1], b[0] - center[0]);
  const end = Math.atan2(c[1] - center[1], c[0] - center[0]);
  const clockwise = turn(end - start);
  return turn(through - start) <= clockwise ? clockwise : turn(start - end);
}

function encodeShapes(shapes: readonly (readonly Polygon[])[]): Float64Array {
  let size = 1;
  for (const shape of shapes) {
    size += 1;
    for (const polygon of shape) {
      size += 1;
      for (const ring of polygon) size += 1 + ring.length * 2;
    }
  }
  const data = new Float64Array(size);
  let cursor = 0;
  data[cursor++] = shapes.length;
  for (const shape of shapes) {
    data[cursor++] = shape.length;
    for (const polygon of shape) {
      data[cursor++] = polygon.length;
      for (const ring of polygon) {
        data[cursor++] = ring.length;
        for (const [x, y] of ring) {
          data[cursor++] = x;
          data[cursor++] = y;
        }
      }
    }
  }
  return data;
}

function decodePolygons(data: Float64Array): Polygon[] {
  let cursor = 0;
  const polygonCount = readCount(data, cursor);
  cursor += 1;
  const polygons: Polygon[] = [];
  for (let polygonIndex = 0; polygonIndex < polygonCount; polygonIndex++) {
    const ringCount = readCount(data, cursor);
    cursor += 1;
    const polygon: Polygon = [];
    for (let ringIndex = 0; ringIndex < ringCount; ringIndex++) {
      const pointCount = readCount(data, cursor);
      cursor += 1;
      const ring: Polygon[number] = [];
      for (let pointIndex = 0; pointIndex < pointCount; pointIndex++) {
        const x = data[cursor++];
        const y = data[cursor++];
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('几何内核返回了非法坐标');
        ring.push([x, y]);
      }
      polygon.push(ring);
    }
    if (polygon.length) polygons.push(polygon);
  }
  return polygons;
}

function readCount(data: Float64Array, cursor: number): number {
  const value = data[cursor];
  if (!Number.isInteger(value) || value < 0) throw new Error('几何内核返回了非法计数');
  return value;
}
