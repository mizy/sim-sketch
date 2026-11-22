import {describe, expect, test, vi} from 'vitest';

// 失败注入：内核加载失败必须走 WebGpuRenderer.fail -> Host 回退，
// 不能只 warn 后让闭合填充永久退化成描边。
vi.mock('../kernel.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../kernel.ts')>();
  return {
    ...actual,
    ensureGeometryKernel: () => Promise.reject(new Error('wasm unavailable'))
  };
});

import {WebGpuRenderer} from '../webgpu-renderer.ts';

describe('WebGPU kernel failure', () => {
  test('reports load failure to the host instead of dropping fills', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onError = vi.fn();
    const device = {
      addEventListener: () => {},
      lost: new Promise(() => {})
    } as unknown as GPUDevice;
    const renderer = new WebGpuRenderer(
      {} as HTMLCanvasElement,
      device,
      {} as GPUCanvasContext,
      'bgra8unorm',
      {} as never,
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

    (renderer as unknown as {requestKernelRepaint: () => void}).requestKernelRepaint();
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(String(onError.mock.calls[0][0])).toContain('wasm unavailable');
    warn.mockRestore();
  });
});
