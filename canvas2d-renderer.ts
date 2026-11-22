import type {RenderPrimitive, RenderScene, RendererOptions, SketchRenderer, SnapMarker} from './renderer.ts';
import {cssColor, rgba, snapColor} from './theme.ts';
import {referenceCanvas} from './reference.ts';
import type {Point} from './geometry.ts';

const MAX_DPR = 2;

function dotLattice(min: number, max: number, spacing: number, origin: number): number[] {
  const step = Math.max(spacing, 1);
  const first = Math.ceil((min - origin) / step - 0.5);
  const last = Math.floor((max - origin) / step + 0.5);
  const values: number[] = [];
  for (let index = first; index <= last; index++) values.push(index * step + origin);
  return values;
}

function addCirclePath(ctx: CanvasRenderingContext2D, center: Point, radius: number): void {
  ctx.beginPath();
  ctx.arc(center[0], center[1], radius, 0, Math.PI * 2);
}

/**
 * @entry Canvas2D 兼容回退：与 WebGpuRenderer 消费同一 RenderScene。
 * 非不透明图层先画到离屏 canvas，再整层合成，保持与 SVG <g opacity> 相同的组透明语义。
 */
export class Canvas2dRenderer implements SketchRenderer {
  readonly backend = 'canvas2d' as const;
  private cssWidth = 0;
  private cssHeight = 0;
  private dpr = 1;
  private failed = false;
  private offscreen: HTMLCanvasElement | null = null;
  private readonly references = new Map<string, HTMLCanvasElement | 'loading'>();
  /** 只缓存当前参考图；切换或移除时释放离屏 canvas。 */
  private referenceSource: string | null = null;

  constructor(private readonly canvas: HTMLCanvasElement, private readonly options: RendererOptions = {}) {
    // 2D context 丢失后 draw 通常静默 no-op，页面会永久停在空白画布；
    // 必须主动上报 Host，让 auto 路径回退到 SVG。
    canvas.addEventListener('contextlost', this.handleContextLost);
  }

  private readonly handleContextLost = (event: Event): void => {
    event.preventDefault();
    if (this.failed) return;
    this.failed = true;
    this.options.onError?.(new Error('Canvas2D context lost'));
  };

  resize(width: number, height: number, dpr: number): void {
    this.cssWidth = Math.max(1, width);
    this.cssHeight = Math.max(1, height);
    this.dpr = Math.min(Math.max(1, dpr), MAX_DPR);
  }

  draw(scene: RenderScene): void {
    if (this.failed) return;
    try {
      this.paint(scene);
    } catch (error) {
      this.failed = true;
      console.warn('Canvas2D 渲染失败。', error);
      this.options.onError?.(error);
    }
  }

  /** 几何直接画在宿主 canvas 上，无需额外清理。 */
  clearGeometry(): void {}

  private paint(scene: RenderScene): void {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas2D context unavailable');
    const source = scene.reference?.source ?? null;
    if (source !== this.referenceSource) {
      this.referenceSource = source;
      this.references.clear();
    }
    this.ensureSize(scene);
    const {viewport} = scene;
    const scale = viewport.pixelsPerWorldUnit * Math.min(Math.max(1, viewport.dpr || this.dpr), MAX_DPR);
    if (!scale || !Number.isFinite(scale)) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = cssColor(scene.background.background);
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.applyWorld(ctx, viewport, scale);
    this.drawGrid(ctx, scene);
    for (const layer of scene.layers) {
      const primitives = [...layer.primitives, ...scene.temporary.filter(item => item.layerId === layer.id)];
      if (!primitives.length && scene.reference?.layerId !== layer.id) continue;
      if ((layer.opacity ?? 1) < .999) this.drawLayerOffscreen(ctx, scene, layer.id, primitives, layer.opacity ?? 1, scale);
      else {
        if (scene.reference?.layerId === layer.id) this.drawReference(ctx, scene.reference.source);
        for (const primitive of primitives) this.drawPrimitive(ctx, primitive, scene);
      }
    }
    for (const marker of scene.snap) this.drawMarker(ctx, marker, scene);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
  }

  destroy(): void {
    this.canvas.removeEventListener('contextlost', this.handleContextLost);
    try {
      const ctx = this.canvas.getContext('2d');
      ctx?.setTransform(1, 0, 0, 1, 0, 0);
      ctx?.clearRect(0, 0, this.canvas.width, this.canvas.height);
    } catch {
      // 已丢失的 context 允许重复 destroy。
    }
    this.offscreen = null;
    this.referenceSource = null;
    this.references.clear();
  }

  private ensureSize(scene: RenderScene): void {
    const dpr = Math.min(Math.max(1, scene.viewport.dpr || this.dpr), MAX_DPR);
    const width = Math.max(1, Math.round((scene.viewport.cssWidth || this.cssWidth) * dpr));
    const height = Math.max(1, Math.round((scene.viewport.cssHeight || this.cssHeight) * dpr));
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
  }

  private applyWorld(ctx: CanvasRenderingContext2D, viewport: RenderScene['viewport'], scale: number): void {
    ctx.setTransform(scale, 0, 0, scale, -viewport.x * scale, -viewport.y * scale);
  }

  private drawGrid(ctx: CanvasRenderingContext2D, scene: RenderScene): void {
    const {viewport, background} = scene;
    ctx.fillStyle = cssColor(background.background);
    ctx.fillRect(viewport.x, viewport.y, viewport.width, viewport.height);
    ctx.fillStyle = cssColor(background.dot);
    const xs = dotLattice(viewport.x, viewport.x + viewport.width, background.spacing, background.origin[0]);
    const ys = dotLattice(viewport.y, viewport.y + viewport.height, background.spacing, background.origin[1]);
    ctx.beginPath();
    for (const x of xs) {
      for (const y of ys) {
        ctx.moveTo(x + background.radius, y);
        ctx.arc(x, y, background.radius, 0, Math.PI * 2);
      }
    }
    ctx.fill();
  }

  private drawLayerOffscreen(main: CanvasRenderingContext2D, scene: RenderScene, layerId: string,
    primitives: RenderPrimitive[], opacity: number, scale: number): void {
    this.offscreen ??= document.createElement('canvas');
    const off = this.offscreen;
    if (off.width !== this.canvas.width) off.width = this.canvas.width;
    if (off.height !== this.canvas.height) off.height = this.canvas.height;
    const ctx = off.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, off.width, off.height);
    ctx.globalAlpha = 1;
    this.applyWorld(ctx, scene.viewport, scale);
    if (scene.reference?.layerId === layerId) this.drawReference(ctx, scene.reference.source);
    for (const primitive of primitives) this.drawPrimitive(ctx, primitive, scene);
    main.setTransform(1, 0, 0, 1, 0, 0);
    main.globalAlpha = opacity;
    main.drawImage(off, 0, 0);
    main.globalAlpha = 1;
    this.applyWorld(main, scene.viewport, scale);
  }

  private drawReference(ctx: CanvasRenderingContext2D, source: string): void {
    const cached = this.references.get(source);
    if (cached instanceof HTMLCanvasElement) {
      ctx.drawImage(cached, 0, 0, 960, 600);
      return;
    }
    if (cached === 'loading') return;
    this.references.set(source, 'loading');
    void referenceCanvas(source).then(canvas => {
      if (this.referenceSource !== source) return;
      this.references.set(source, canvas);
      this.options.onInvalidate?.();
    }).catch(() => {
      if (this.referenceSource === source) this.references.delete(source);
    });
  }

  private drawPrimitive(ctx: CanvasRenderingContext2D, primitive: RenderPrimitive, scene: RenderScene): void {
    switch (primitive.kind) {
      case 'stroke': {
        const points = primitive.points;
        if (points.length < 2) return;
        ctx.beginPath();
        ctx.moveTo(points[0][0], points[0][1]);
        for (let index = 1; index < points.length; index++) ctx.lineTo(points[index][0], points[index][1]);
        if (primitive.closed) ctx.closePath();
        ctx.strokeStyle = cssColor(primitive.color);
        ctx.lineWidth = primitive.width;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.setLineDash(primitive.dash ? [...primitive.dash] : []);
        ctx.stroke();
        ctx.setLineDash([]);
        return;
      }
      case 'ellipse': {
        ctx.beginPath();
        ctx.ellipse(primitive.center[0], primitive.center[1], Math.max(.1, primitive.radii[0]),
          Math.max(.1, primitive.radii[1]), 0, 0, Math.PI * 2);
        if (primitive.fill) {
          ctx.fillStyle = cssColor([primitive.color[0], primitive.color[1], primitive.color[2],
            primitive.fill * primitive.color[3]]);
          ctx.fill();
        }
        ctx.strokeStyle = cssColor(primitive.color);
        ctx.lineWidth = primitive.width;
        ctx.setLineDash(primitive.dash ? [9, 5] : []);
        ctx.stroke();
        ctx.setLineDash([]);
        return;
      }
      case 'fill': {
        ctx.beginPath();
        for (const polygon of primitive.polygons) for (const ring of polygon) {
          if (ring.length < 3) continue;
          ctx.moveTo(ring[0][0], ring[0][1]);
          for (let index = 1; index < ring.length; index++) ctx.lineTo(ring[index][0], ring[index][1]);
          ctx.closePath();
        }
        ctx.fillStyle = cssColor([primitive.color[0], primitive.color[1], primitive.color[2],
          primitive.opacity * primitive.color[3]]);
        ctx.fill('evenodd');
        return;
      }
      case 'marker':
        this.drawMarker(ctx, primitive.marker, scene, primitive.color);
        return;
    }
  }

  private drawMarker(ctx: CanvasRenderingContext2D, marker: SnapMarker, scene: RenderScene,
    color = rgba(snapColor)): void {
    const ppu = Math.max(scene.viewport.pixelsPerWorldUnit, .01);
    const size = 7 / ppu;
    const [x, y] = marker.point;
    ctx.lineCap = 'round';
    for (const [width, stroke] of [[3.5 / ppu, '#ffffff'], [1.8 / ppu, cssColor(color)]] as const) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(x - size, y);
      ctx.lineTo(x + size, y);
      ctx.moveTo(x, y - size);
      ctx.lineTo(x, y + size);
      ctx.stroke();
      addCirclePath(ctx, [x, y], size * .62);
      ctx.stroke();
    }
  }
}

export function createCanvas2dRenderer(canvas: HTMLCanvasElement, options: RendererOptions = {}): Canvas2dRenderer {
  // 工厂阶段就验证 context：Host 只有在 mount 成功后才交换 canvas，
  // 否则会出现 data-renderer=canvas2d 但页面空白的假成功。
  if (!canvas.getContext('2d')) throw new Error('Canvas2D context unavailable');
  return new Canvas2dRenderer(canvas, options);
}
