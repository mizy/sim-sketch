import {INSTANCE_FLOATS, packPrimitives, buildFillGeometry} from './gpu-scene.ts';
import type {FillGeometry, GpuDrawOp} from './gpu-scene.ts';
import {recordOpaqueFills, recordOpaqueStrokes, recordTranslucent} from './webgpu-layer-pass.ts';
import type {LayerDrawResources} from './webgpu-layer-pass.ts';
import {ensureGeometryKernel} from './kernel.ts';
import type {MarkerPrimitive, RenderLayer, RenderPrimitive, RenderScene, RendererOptions, SketchRenderer} from './renderer.ts';
import {createPipelines} from './webgpu-shaders.ts';
import type {GpuPipelines} from './webgpu-shaders.ts';
import {referenceCanvas} from './reference.ts';
import {rgba, snapColor} from './theme.ts';
import {withTimeout} from './timeout.ts';

interface LayerPacket {
  layer: RenderLayer;
  ops: GpuDrawOp[];
  instances: Float32Array<ArrayBuffer>;
  hasReference: boolean;
}

interface Surface {
  width: number;
  height: number;
  offscreen: GPUTexture;
  offscreenView: GPUTextureView;
  depth: GPUTexture;
  depthView: GPUTextureView;
  composite: GPUBindGroup;
}

interface ReferenceTexture {
  source: string;
  texture: GPUTexture;
  bind: GPUBindGroup;
}

const ADAPTER_TIMEOUT_MS = 5000;
const KERNEL_TIMEOUT_MS = 8000;

/** 诊断标记只暴露短标识，避免把导入图的 data URL 再复制进 DOM。 */
function referenceLabel(source: string): string {
  return source.startsWith('data:') ? 'import' : source;
}

function growBuffer(device: GPUDevice, previous: GPUBuffer | null, bytes: number): GPUBuffer {
  if (previous && previous.size >= bytes) return previous;
  previous?.destroy();
  return device.createBuffer({size: Math.max(4096, 2 ** Math.ceil(Math.log2(bytes))),
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST});
}

/**
 * @entry WebGPU 主渲染器。draw() 同步编码一帧；初始化、pipeline、reference 纹理在工厂内完成。
 * 文字/标注气泡不进这里，由 SVG overlay 负责。
 */
export class WebGpuRenderer implements SketchRenderer {
  readonly backend = 'webgpu' as const;
  private disposed = false;
  private failed = false;
  private cssWidth = 0;
  private cssHeight = 0;
  private dpr = 1;
  private surface: Surface | null = null;
  private strokeBuffer: GPUBuffer | null = null;
  private snapBuffer: GPUBuffer | null = null;
  private fillBuffer: GPUBuffer | null = null;
  private opacityBuffer: GPUBuffer | null = null;
  /** 上一帧上传的数据；拖动时只回写变化区间，避免每帧覆盖整块在飞缓冲。 */
  private strokeData: Float32Array<ArrayBuffer> | null = null;
  private fillData: Float32Array<ArrayBuffer> | null = null;
  private reference: ReferenceTexture | null = null;
  private requestedReference: string | null = null;
  /** 参考图加载令牌；source 变化或移除时递增，旧 Promise 不得回写。 */
  private referenceToken = 0;
  private kernelPending = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly device: GPUDevice,
    private readonly context: GPUCanvasContext,
    private readonly format: GPUTextureFormat,
    private readonly pipelines: GpuPipelines,
    private readonly uniforms: {view: GPUBuffer; grid: GPUBindGroup; strokeOpaque: GPUBindGroup;
      strokeTranslucent: GPUBindGroup; fillOpaque: GPUBindGroup; fillTranslucent: GPUBindGroup},
    private readonly sampler: GPUSampler,
    private readonly options: RendererOptions
  ) {
    device.addEventListener('uncapturederror', event => {
      event.preventDefault();
      this.fail((event as GPUUncapturedErrorEvent).error);
    });
    void device.lost.then(info => {
      if (!this.disposed) this.fail(new Error(info.message || info.reason));
    });
  }

  resize(width: number, height: number, dpr: number): void {
    this.cssWidth = Math.max(1, width);
    this.cssHeight = Math.max(1, height);
    this.dpr = Math.min(Math.max(1, dpr), 2);
  }

  draw(scene: RenderScene): void {
    if (this.disposed || this.failed) return;
    try {
      if (!this.ensureSurface(scene)) return;
      const surface = this.surface!;
      const packets = this.packScene(scene);
      const fills = buildFillGeometry(packets.flatMap(packet => packet.ops));
      const instances = this.packInstances(packets);
      const snap = this.packSnap(scene);
      this.uploadStrokes(instances);
      this.uploadFill(fills.vertices);
      this.uploadOpacities(scene.layers);
      this.uploadUniforms(scene);
      if (fills.needsKernel) this.requestKernelRepaint();
      this.syncReference(scene.reference?.source ?? null);

      const encoder = this.device.createCommandEncoder();
      const target = this.context.getCurrentTexture().createView();
      this.drawGrid(encoder, target);
      packets.forEach((packet, index) => {
        if (!packet.ops.length && !packet.hasReference) return;
        const opacity = packet.layer.opacity ?? 1;
        const offscreen = opacity < .999;
        this.drawLayer(encoder, offscreen ? surface.offscreenView : target, surface.depthView,
          packet, fills.ranges, offscreen);
        if (offscreen) this.composite(encoder, target, index);
      });
      if (snap.length) {
        this.snapBuffer = growBuffer(this.device, this.snapBuffer, snap.byteLength);
        this.device.queue.writeBuffer(this.snapBuffer, 0, snap);
        const pass = encoder.beginRenderPass({
          colorAttachments: [{view: target, loadOp: 'load', storeOp: 'store'}],
          // stroke pipeline 声明了 depthStencil，snap pass 必须提供同格式深度附件。
          depthStencilAttachment: {view: surface.depthView, depthLoadOp: 'clear',
            depthClearValue: 1, depthStoreOp: 'store'}
        });
        pass.setPipeline(this.pipelines.strokeOpaque);
        pass.setBindGroup(0, this.uniforms.strokeOpaque);
        pass.setVertexBuffer(0, this.snapBuffer);
        pass.draw(4, snap.length / INSTANCE_FLOATS);
        pass.end();
      }
      this.device.queue.submit([encoder.finish()]);
    } catch (error) {
      this.fail(error);
    }
  }

  /** 几何只存在于本 renderer 的 canvas 上，宿主移除 canvas 即完成清理。 */
  clearGeometry(): void {}

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearReference();
    this.surface?.offscreen.destroy();
    this.surface?.depth.destroy();
    this.surface = null;
    for (const buffer of [this.strokeBuffer, this.snapBuffer, this.fillBuffer, this.opacityBuffer]) {
      buffer?.destroy();
    }
    this.strokeBuffer = this.snapBuffer = this.fillBuffer = this.opacityBuffer = null;
    this.strokeData = this.fillData = null;
    this.uniforms.view.destroy();
    try {
      this.context.unconfigure();
    } catch {
      // 已失效的 context 允许重复 destroy。
    }
    this.device.destroy();
  }

  private fail(error: unknown): void {
    if (this.disposed || this.failed) return;
    this.failed = true;
    console.warn('WebGPU 渲染器运行失败。', error instanceof Error ? error.message : error);
    this.options.onError?.(error);
  }

  /**
   * 首帧可能早于 Wasm 预热；内核就绪后请求 Host 重画一次。
   * 内核加载失败时不能让闭合填充永久退化成描边：上报 Host 回退到
   * Canvas2D/SVG，它们本来就能用 even-odd 正常填充。
   */
  private requestKernelRepaint(): void {
    if (this.kernelPending || this.disposed) return;
    this.kernelPending = true;
    void withTimeout(ensureGeometryKernel(), KERNEL_TIMEOUT_MS, '几何内核加载超时').then(() => {
      this.kernelPending = false;
      if (!this.disposed) this.options.onInvalidate?.();
    }).catch(error => {
      this.kernelPending = false;
      if (!this.disposed) this.fail(error);
    });
  }

  private ensureSurface(scene: RenderScene): boolean {
    const width = scene.viewport.cssWidth || this.cssWidth;
    const height = scene.viewport.cssHeight || this.cssHeight;
    if (!width || !height) return false;
    const max = this.device.limits.maxTextureDimension2D;
    const dpr = scene.viewport.dpr || this.dpr || 1;
    const scale = Math.min(Math.min(Math.max(1, dpr), 2), max / Math.max(width, height, 1));
    const pixelWidth = Math.max(1, Math.min(max, Math.round(width * scale)));
    const pixelHeight = Math.max(1, Math.min(max, Math.round(height * scale)));
    if (this.surface?.width === pixelWidth && this.surface?.height === pixelHeight) return true;
    this.surface?.offscreen.destroy();
    if (this.canvas.width !== pixelWidth) this.canvas.width = pixelWidth;
    if (this.canvas.height !== pixelHeight) this.canvas.height = pixelHeight;
    this.surface?.depth.destroy();
    const offscreen = this.device.createTexture({size: [pixelWidth, pixelHeight], format: this.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING});
    const depth = this.device.createTexture({size: [pixelWidth, pixelHeight], format: 'depth24plus',
      usage: GPUTextureUsage.RENDER_ATTACHMENT});
    this.surface = {
      width: pixelWidth, height: pixelHeight,
      offscreen, offscreenView: offscreen.createView(),
      depth, depthView: depth.createView(),
      composite: this.device.createBindGroup({layout: this.pipelines.composite.getBindGroupLayout(0),
        entries: [{binding: 0, resource: this.sampler}, {binding: 1, resource: offscreen.createView()}]})
    };
    return true;
  }

  private packScene(scene: RenderScene): LayerPacket[] {
    return scene.layers.map(layer => {
      const primitives: RenderPrimitive[] = [
        ...layer.primitives,
        ...scene.temporary.filter(item => item.layerId === layer.id)
      ];
      const packed = packPrimitives(primitives, scene.viewport.pixelsPerWorldUnit);
      return {layer, ops: packed.ops, instances: packed.instances,
        hasReference: scene.reference?.layerId === layer.id};
    });
  }

  private packInstances(packets: LayerPacket[]): Float32Array<ArrayBuffer> {
    // 单图层是常态；直接复用打包结果，避免每帧再复制一份 100KB+ 顶点缓冲。
    if (packets.length === 1) return packets[0].instances;
    const total = packets.reduce((sum, packet) => sum + packet.instances.length, 0);
    const output = new Float32Array(total);
    let offset = 0;
    let floatOffset = 0;
    for (const packet of packets) {
      for (const op of packet.ops) {
        if (op.kind === 'stroke') op.first += offset;
      }
      output.set(packet.instances, floatOffset);
      floatOffset += packet.instances.length;
      offset += packet.instances.length / INSTANCE_FLOATS;
    }
    return output;
  }

  private packSnap(scene: RenderScene): Float32Array<ArrayBuffer> {
    const primitives: MarkerPrimitive[] = scene.snap.map(marker => ({
      kind: 'marker', layerId: '__snap', marker, color: rgba(snapColor)
    }));
    return packPrimitives(primitives, scene.viewport.pixelsPerWorldUnit).instances;
  }

  private uploadStrokes(instances: Float32Array<ArrayBuffer>): void {
    if (!instances.length) return;
    const previousBuffer = this.strokeBuffer;
    this.strokeBuffer = growBuffer(this.device, this.strokeBuffer, instances.byteLength);
    this.writeChanged(this.strokeBuffer, this.strokeData, instances, this.strokeBuffer !== previousBuffer);
    this.strokeData = instances.slice();
  }

  private uploadFill(vertices: Float32Array<ArrayBuffer>): void {
    if (!vertices.length) return;
    const previousBuffer = this.fillBuffer;
    this.fillBuffer = growBuffer(this.device, this.fillBuffer, vertices.byteLength);
    this.writeChanged(this.fillBuffer, this.fillData, vertices, this.fillBuffer !== previousBuffer);
    this.fillData = vertices.slice();
  }

  /** 静态帧完全跳过上传；拖动时只回写变化的 float 区间。 */
  private writeChanged(buffer: GPUBuffer, previous: Float32Array<ArrayBuffer> | null,
    next: Float32Array<ArrayBuffer>, force: boolean): void {
    if (force || !previous || previous.length !== next.length) {
      this.device.queue.writeBuffer(buffer, 0, next);
      return;
    }
    let first = 0;
    while (first < next.length && previous[first] === next[first]) first++;
    if (first === next.length) return;
    let last = next.length - 1;
    while (last > first && previous[last] === next[last]) last--;
    this.device.queue.writeBuffer(buffer, first * 4, next.subarray(first, last + 1));
  }

  private uploadUniforms(scene: RenderScene): void {
    const {viewport, background} = scene;
    this.device.queue.writeBuffer(this.uniforms.view, 0, new Float32Array([
      viewport.x, viewport.y, viewport.width, viewport.height,
      background.spacing, background.radius, background.origin[0], background.origin[1],
      ...background.background, ...background.dot
    ]));
  }

  private uploadOpacities(layers: RenderLayer[]): void {
    const data = new Float32Array(layers.length * 4);
    layers.forEach((layer, index) => { data[index * 4] = layer.opacity ?? 1; });
    this.opacityBuffer = growBuffer(this.device, this.opacityBuffer, data.byteLength);
    this.device.queue.writeBuffer(this.opacityBuffer, 0, data);
  }

  private drawGrid(encoder: GPUCommandEncoder, target: GPUTextureView): void {
    const pass = encoder.beginRenderPass({colorAttachments: [{
      view: target, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1]
    }]});
    pass.setPipeline(this.pipelines.grid);
    pass.setBindGroup(0, this.uniforms.grid);
    pass.draw(4);
    pass.end();
  }

  /**
   * 一个图层一个 pass，按三段绘制：
   * 1. 参考图：不写深度，作为图层底图；
   * 2. 不透明内容：写深度，用 painter depth 消除 fill/stroke 批处理顺序；
   * 3. 半透明内容：严格按 painter 顺序、depthWriteEnabled=false，避免透明片元
   *    写深度后把更早的填充/光晕整块剔除。
   */
  private drawLayer(encoder: GPUCommandEncoder, target: GPUTextureView, depth: GPUTextureView,
    packet: LayerPacket, ranges: FillGeometry['ranges'], clear: boolean): void {
    const pass = encoder.beginRenderPass({
      colorAttachments: [{view: target, loadOp: clear ? 'clear' : 'load', storeOp: 'store',
        clearValue: [0, 0, 0, 0]}],
      depthStencilAttachment: {view: depth, depthLoadOp: 'clear', depthClearValue: 1,
        depthStoreOp: 'store'}
    });
    if (packet.hasReference) this.recordReference(pass);
    const resources = this.layerResources();
    recordOpaqueStrokes(pass, packet.ops, resources);
    recordOpaqueFills(pass, packet.ops, ranges, resources);
    recordTranslucent(pass, packet.ops, ranges, resources);
    pass.end();
  }

  private layerResources(): LayerDrawResources {
    return {pipelines: this.pipelines, uniforms: this.uniforms,
      strokeBuffer: this.strokeBuffer, fillBuffer: this.fillBuffer};
  }

  private composite(encoder: GPUCommandEncoder, target: GPUTextureView, layerIndex: number): void {
    if (!this.surface || !this.opacityBuffer) return;
    const pass = encoder.beginRenderPass({colorAttachments: [{view: target, loadOp: 'load', storeOp: 'store'}]});
    pass.setPipeline(this.pipelines.composite);
    pass.setBindGroup(0, this.surface.composite);
    pass.setVertexBuffer(0, this.opacityBuffer);
    pass.draw(4, 1, 0, layerIndex);
    pass.end();
  }

  private recordReference(pass: GPURenderPassEncoder): void {
    if (!this.reference) return;
    pass.setPipeline(this.pipelines.reference);
    pass.setBindGroup(0, this.reference.bind);
    pass.draw(4);
  }

  /**
   * scene.reference 是唯一真源：null 时立即清空，source 变化时先清旧图再加载新图，
   * 同一 source 处于加载中或已就绪时不重复请求。
   */
  private syncReference(source: string | null): void {
    if (source && (this.reference?.source === source || this.requestedReference === source)) return;
    if (!source && !this.reference && !this.requestedReference) return;
    this.clearReference();
    if (source) this.loadReference(source);
  }

  /** 统一释放参考图纹理、诊断标记与在飞请求；销毁/切换/移除都走这里。 */
  private clearReference(): void {
    this.referenceToken++;
    this.requestedReference = null;
    this.reference?.texture.destroy();
    this.reference = null;
    delete this.canvas.dataset.reference;
  }

  private loadReference(source: string): void {
    this.requestedReference = source;
    const token = ++this.referenceToken;
    void referenceCanvas(source).then(canvas => {
      if (this.disposed || token !== this.referenceToken) return;
      const texture = this.device.createTexture({size: [canvas.width, canvas.height], format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT});
      this.device.queue.copyExternalImageToTexture({source: canvas},
        {texture, premultipliedAlpha: true}, [canvas.width, canvas.height]);
      const bind = this.device.createBindGroup({layout: this.pipelines.reference.getBindGroupLayout(0), entries: [
        {binding: 0, resource: {buffer: this.uniforms.view}},
        {binding: 1, resource: this.sampler},
        {binding: 2, resource: texture.createView()}
      ]});
      this.reference = {source, texture, bind};
      this.canvas.dataset.reference = referenceLabel(source);
      this.options.onInvalidate?.();
    }).catch(error => {
      if (token !== this.referenceToken) return;
      this.requestedReference = null;
      console.warn('参考图加载失败。', error);
    });
  }
}

export async function createWebGpuRenderer(canvas: HTMLCanvasElement,
  options: RendererOptions = {}): Promise<WebGpuRenderer> {
  if (!navigator.gpu) throw new Error('当前浏览器不支持 WebGPU');
  const adapter = await withTimeout(navigator.gpu.requestAdapter({powerPreference: 'high-performance'}),
    ADAPTER_TIMEOUT_MS, 'WebGPU adapter 请求超时');
  if (!adapter) throw new Error('没有可用的 WebGPU adapter');
  const pendingDevice = adapter.requestDevice();
  let abandoned = false;
  let device: GPUDevice;
  try {
    device = await withTimeout(pendingDevice, ADAPTER_TIMEOUT_MS, 'WebGPU device 请求超时');
  } catch (error) {
    // 超时后 device 仍可能晚到；没人持有它时必须主动 destroy，避免 GPU 资源泄漏。
    abandoned = true;
    void pendingDevice.then(late => { if (abandoned) late.destroy(); }).catch(() => undefined);
    throw error;
  }
  try {
    const context = canvas.getContext('webgpu');
    if (!context) throw new Error('无法获取 WebGPU canvas context');
    const format = navigator.gpu.getPreferredCanvasFormat();
    const pipelines = createPipelines(device, format);
    context.configure({device, format, alphaMode: 'opaque',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | (options.capture ? GPUTextureUsage.COPY_SRC : 0)});
    const view = device.createBuffer({size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST});
    const bind = (pipeline: GPURenderPipeline): GPUBindGroup => device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0), entries: [{binding: 0, resource: {buffer: view}}]
    });
    const sampler = device.createSampler({magFilter: 'linear', minFilter: 'linear',
      addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge'});
    return new WebGpuRenderer(canvas, device, context, format, pipelines,
      {view, grid: bind(pipelines.grid), strokeOpaque: bind(pipelines.strokeOpaque),
        strokeTranslucent: bind(pipelines.strokeTranslucent), fillOpaque: bind(pipelines.fillOpaque),
        fillTranslucent: bind(pipelines.fillTranslucent)}, sampler, options);
  } catch (error) {
    device.destroy();
    throw error;
  }
}
