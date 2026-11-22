import {describe, expect, test, vi} from 'vitest';

// 失败注入：内核已就绪但三角化返回运行期异常时，draw 必须 fail -> Host 回退，
// 不能缓存一帧空填充后让 WebGPU 永久缺填充。
vi.mock('../gpu-scene.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../gpu-scene.ts')>();
  return {
    ...actual,
    buildFillGeometry: () => { throw new Error('invalid tessellation index'); }
  };
});

import {WebGpuRenderer} from '../webgpu-renderer.ts';
import type {RenderScene} from '../renderer.ts';

function scene(): RenderScene {
  return {
    revision: 1,
    viewport: {x: 0, y: 0, width: 100, height: 100, cssWidth: 200, cssHeight: 200, dpr: 1,
      pixelsPerWorldUnit: 2},
    background: {spacing: 24, radius: .1, origin: [1.4, 1.4],
      background: [1, 1, 1, 1], dot: [.9, .9, .9, 1]},
    reference: null,
    layers: [{id: 'layer', opacity: 1, primitives: [
      {kind: 'fill', layerId: 'layer', polygons: [[[[0, 0], [10, 0], [10, 10]]]],
        color: [.8, .1, .1, 1], opacity: 1}
    ]}],
    temporary: [], snap: []
  };
}

describe('WebGPU tessellation failure', () => {
  test('runtime tessellation errors reach onError instead of dropping the fill', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    (globalThis as {GPUTextureUsage?: unknown}).GPUTextureUsage = {
      RENDER_ATTACHMENT: 1, TEXTURE_BINDING: 2, COPY_SRC: 4
    };
    const onError = vi.fn();
    const texture = {destroy: () => {}, createView: () => ({})};
    const device = {
      addEventListener: () => {},
      lost: new Promise(() => {}),
      limits: {maxTextureDimension2D: 4096},
      createTexture: () => texture,
      createBindGroup: () => ({}),
      createBuffer: () => ({})
    } as unknown as GPUDevice;
    const renderer = new WebGpuRenderer(
      {width: 200, height: 200} as HTMLCanvasElement,
      device,
      {} as GPUCanvasContext,
      'bgra8unorm',
      {composite: {getBindGroupLayout: () => ({})}} as never,
      {
        view: {} as GPUBuffer,
        grid: {} as GPUBindGroup,
        strokeOpaque: {} as GPUBindGroup,
        strokeTranslucent: {} as GPUBindGroup,
        fillOpaque: {} as GPUBindGroup,
        fillTranslucent: {} as GPUBindGroup
      },
      {} as GPUSampler,
      {onError}
    );

    renderer.draw(scene());
    expect(onError).toHaveBeenCalledTimes(1);
    expect(String(onError.mock.calls[0][0])).toContain('invalid tessellation index');
    warn.mockRestore();
  });
});
