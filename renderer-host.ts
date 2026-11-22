import type {RendererBackend, RenderScene, SketchRenderer} from './renderer.ts';
import {createCanvas2dRenderer} from './canvas2d-renderer.ts';
import {createWebGpuRenderer} from './webgpu-renderer.ts';
import {resolveRendererMode} from './rendererMode.ts';
import type {RendererMode} from './rendererMode.ts';
import {SvgRenderer} from './svg-renderer.ts';

export interface RendererHostOptions {
  board: SVGSVGElement;
  /** 由 app 提供：重建 scene + overlay 后调用 host.draw。 */
  paint: () => void;
}

/**
 * @entry 渲染后端生命周期：URL 选择、升级/回退、canvas 交换、错误上报。
 * 切换时先初始化新后端，再替换 canvas 和 backend，最后销毁旧 renderer，避免闪白。
 */
export class RendererHost {
  private readonly svg: SvgRenderer;
  private renderer: SketchRenderer;
  private canvas: HTMLCanvasElement | null = null;
  private backend: RendererBackend = 'svg';
  private mode: RendererMode = 'auto';
  private generation = 0;

  constructor(private readonly options: RendererHostOptions) {
    this.svg = new SvgRenderer(options.board);
    this.renderer = this.svg;
  }


  async start(): Promise<void> {
    this.mode = resolveRendererMode(location.search);
    if (this.mode === 'svg') {
      this.activateSvg();
      return;
    }
    if (this.mode === 'canvas2d') {
      if (!await this.mount('canvas2d')) this.activateSvg();
      return;
    }
    if (this.mode === 'webgpu') {
      // 显式指定 webgpu 时不再静默降级到 Canvas2D，避免诊断结果被 auto 路径混淆；
      // 仍保留 SVG 作为可见的最终兜底。
      if (!await this.mount('webgpu')) this.activateSvg();
      return;
    }
    if (await this.mount('webgpu')) return;
    if (await this.mount('canvas2d')) return;
    this.activateSvg();
  }

  resize(width: number, height: number, dpr: number): void {
    this.renderer.resize(width, height, dpr);
  }

  draw(scene: RenderScene): void {
    this.renderer.draw(scene);
  }

  destroy(): void {
    if (this.renderer !== this.svg) this.renderer.destroy();
    this.renderer = this.svg;
    this.removeCanvas();
    this.svg.destroy();
  }

  private activateSvg(): void {
    this.generation++;
    if (this.renderer !== this.svg) this.renderer.destroy();
    this.renderer = this.svg;
    this.removeCanvas();
    this.backend = 'svg';
    this.show();
    this.options.paint();
  }

  private async mount(backend: 'webgpu' | 'canvas2d'): Promise<boolean> {
    const generation = ++this.generation;
    const canvas = this.newCanvas();
    const rect = this.options.board.getBoundingClientRect();
    const dpr = Math.min(devicePixelRatio || 1, 2);
    let next: SketchRenderer | null = null;
    try {
      const created = backend === 'canvas2d'
        ? createCanvas2dRenderer(canvas, {onInvalidate: () => this.options.paint(),
          onError: error => this.handleError(generation, 'canvas2d', error)})
        : await createWebGpuRenderer(canvas, {onInvalidate: () => this.options.paint(),
          onError: error => this.handleError(generation, 'webgpu', error)});
      next = created;
      if (generation !== this.generation) {
        next.destroy();
        return false;
      }
      const previous = this.renderer;
      next.resize(rect.width || this.options.board.clientWidth,
        rect.height || this.options.board.clientHeight, dpr);
      this.swapCanvas(canvas);
      // GPU/Canvas2D 接管画布前清掉 SVG 遗留几何，避免两层同时可见。
      this.svg.clearGeometry();
      this.renderer = next;
      this.backend = backend;
      this.show();
      this.options.paint();
      if (previous !== this.svg) previous.destroy();
      return true;
    } catch (error) {
      next?.destroy();
      console.warn(`渲染器 ${backend} 初始化失败。`, error);
      return false;
    }
  }

  private handleError(generation: number, backend: 'webgpu' | 'canvas2d', error: unknown): void {
    if (generation !== this.generation) return;
    this.generation++;
    if (backend === 'canvas2d' || this.mode === 'webgpu') {
      console.warn(`渲染器 ${backend} 运行中失效，回退 SVG。`, error);
      this.activateSvg();
      return;
    }
    console.warn('WebGPU 运行中失效，回退 Canvas2D。', error);
    void this.mount('canvas2d').then(ok => {
      if (!ok) this.activateSvg();
    });
  }

  private show(): void {
    const wrap = this.options.board.parentElement;
    if (!wrap) return;
    wrap.dataset.gpu = String(this.backend !== 'svg');
    wrap.dataset.renderer = this.backend;
    this.options.board.dataset.renderer = this.backend;
  }

  private newCanvas(): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.id = 'gpu-board';
    canvas.setAttribute('aria-hidden', 'true');
    return canvas;
  }

  private swapCanvas(next: HTMLCanvasElement): void {
    const previous = this.canvas ?? this.options.board.previousElementSibling;
    this.options.board.before(next);
    if (previous instanceof HTMLCanvasElement) previous.remove();
    this.canvas = next;
  }

  private removeCanvas(): void {
    this.canvas?.remove();
    this.canvas = null;
  }
}
