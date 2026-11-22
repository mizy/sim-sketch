import type {FillGeometry, GpuDrawOp, GpuFillOp, GpuStrokeOp} from './gpu-scene.ts';
import type {GpuPipelines} from './webgpu-shaders.ts';

/** 当前图层的 GPU 资源；缓冲会随图元增长，因此每次 pass 重新读取。 */
export interface LayerDrawResources {
  pipelines: GpuPipelines;
  uniforms: {
    strokeOpaque: GPUBindGroup;
    strokeTranslucent: GPUBindGroup;
    fillOpaque: GPUBindGroup;
    fillTranslucent: GPUBindGroup;
  };
  strokeBuffer: GPUBuffer | null;
  fillBuffer: GPUBuffer | null;
}

/** @entry 不透明描边可以跨 painter 顺序合批；先后由实例自身的 depth 决定。 */
export function recordOpaqueStrokes(pass: GPURenderPassEncoder, ops: GpuDrawOp[],
  resources: LayerDrawResources): void {
  const {strokeBuffer, pipelines, uniforms} = resources;
  if (!strokeBuffer) return;
  const strokes = ops.filter((op): op is GpuStrokeOp => op.kind === 'stroke' && !op.translucent);
  if (!strokes.length) return;
  pass.setPipeline(pipelines.strokeOpaque);
  pass.setBindGroup(0, uniforms.strokeOpaque);
  pass.setVertexBuffer(0, strokeBuffer);
  let first = strokes[0].first;
  let count = strokes[0].count;
  for (const op of strokes.slice(1)) {
    if (op.first === first + count) count += op.count;
    else {
      pass.draw(4, count, 0, first);
      first = op.first;
      count = op.count;
    }
  }
  pass.draw(4, count, 0, first);
}

/** 不透明填充同样可以合批，深度负责与描边、其他填充的先后。 */
export function recordOpaqueFills(pass: GPURenderPassEncoder, ops: GpuDrawOp[],
  ranges: FillGeometry['ranges'], resources: LayerDrawResources): void {
  const {fillBuffer, pipelines, uniforms} = resources;
  if (!fillBuffer) return;
  const draws = ops.filter((op): op is GpuFillOp => op.kind === 'fill' && !op.translucent)
    .map(op => ranges.get(op))
    .filter((range): range is NonNullable<typeof range> => Boolean(range));
  if (!draws.length) return;
  pass.setPipeline(pipelines.fillOpaque);
  pass.setBindGroup(0, uniforms.fillOpaque);
  pass.setVertexBuffer(0, fillBuffer);
  let start = draws[0].vertexFirst;
  let count = draws[0].vertexCount;
  for (const range of draws.slice(1)) {
    if (range.vertexFirst === start + count) count += range.vertexCount;
    else {
      pass.draw(count, 1, start);
      start = range.vertexFirst;
      count = range.vertexCount;
    }
  }
  pass.draw(count, 1, start);
}

/**
 * 半透明内容不写深度，必须在同一 pass 内保持 painter 顺序。
 * 连续且缓冲区相邻的同类型 op 仍然可以合并，避免 2000 个半透明填充逐个 draw。
 */
export function recordTranslucent(pass: GPURenderPassEncoder, ops: GpuDrawOp[],
  ranges: FillGeometry['ranges'], resources: LayerDrawResources): void {
  const {strokeBuffer, fillBuffer, pipelines, uniforms} = resources;
  let mode: 'stroke' | 'fill' | null = null;
  let start = 0;
  let count = 0;
  const flush = (): void => {
    if (mode === 'stroke' && strokeBuffer) {
      pass.setPipeline(pipelines.strokeTranslucent);
      pass.setBindGroup(0, uniforms.strokeTranslucent);
      pass.setVertexBuffer(0, strokeBuffer);
      pass.draw(4, count, 0, start);
    } else if (mode === 'fill' && fillBuffer) {
      pass.setPipeline(pipelines.fillTranslucent);
      pass.setBindGroup(0, uniforms.fillTranslucent);
      pass.setVertexBuffer(0, fillBuffer);
      pass.draw(count, 1, start);
    }
    mode = null;
  };
  for (const op of ops) {
    if (!op.translucent) continue;
    if (op.kind === 'stroke') {
      if (mode === 'stroke' && op.first === start + count) count += op.count;
      else {
        flush();
        mode = 'stroke';
        start = op.first;
        count = op.count;
      }
      continue;
    }
    const range = ranges.get(op);
    if (!range) continue;
    if (mode === 'fill' && range.vertexFirst === start + count) count += range.vertexCount;
    else {
      flush();
      mode = 'fill';
      start = range.vertexFirst;
      count = range.vertexCount;
    }
  }
  flush();
}
