import type {RendererBackend} from './renderer.ts';

export type RendererMode = 'auto' | RendererBackend;

/**
 * 默认走 `auto`：WebGPU 优先，不可用时由 Host 依次回退 Canvas2D、SVG。
 * `?renderer=svg` 仅保留给导出对照和排查，不再是产品默认路径。
 */
export function resolveRendererMode(search: string): RendererMode {
  const value = new URLSearchParams(search).get('renderer');
  if (value === 'auto' || value === 'webgpu' || value === 'canvas2d' || value === 'svg') return value;
  return 'auto';
}
