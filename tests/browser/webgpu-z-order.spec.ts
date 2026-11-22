import {expect, test} from '@playwright/test';

const background = {spacing: 24, radius: .1, origin: [1.4, 1.4],
  background: [1, 1, 1, 1], dot: [.9, .9, .9, 1]};

const scene = (fillFirst: boolean) => ({
  revision: 1,
  viewport: {x: 0, y: 0, width: 100, height: 100, cssWidth: 200, cssHeight: 200, dpr: 1,
    pixelsPerWorldUnit: 2},
  background,
  reference: null,
  layers: [{id: 'layer', opacity: 1, primitives: [
    ...(fillFirst ? [{kind: 'fill' as const, layerId: 'layer',
      polygons: [[[[30, 20], [70, 20], [70, 80], [30, 80]]]], color: [0, 0, 1, 1], opacity: 1}] : []),
    {kind: 'stroke' as const, layerId: 'layer', points: [[10, 50], [90, 50]],
      color: [1, 0, 0, 1], width: 20},
    ...(!fillFirst ? [{kind: 'fill' as const, layerId: 'layer',
      polygons: [[[[30, 20], [70, 20], [70, 80], [30, 80]]]], color: [0, 0, 1, 1], opacity: 1}] : [])
  ]}],
  temporary: [],
  // 让 snap pass 也执行，覆盖 snap 与图层 pass 的先后顺序。
  snap: [{kind: 'grid', point: [10, 90]}]
});

/** 半透明填充覆盖较早的描边：必须像 Canvas2D 一样透出红色，而不是被深度挡掉。 */
const translucentOverStrokeScene = {
  ...scene(false),
  layers: [{id: 'layer', opacity: 1, primitives: [
    {kind: 'stroke' as const, layerId: 'layer', points: [[10, 50], [90, 50]],
      color: [1, 0, 0, 1], width: 20},
    {kind: 'fill' as const, layerId: 'layer',
      polygons: [[[[30, 20], [70, 20], [70, 80], [30, 80]]]], color: [0, 0, 1, 1], opacity: .2}
  ]}],
  snap: []
};

/** 选中直线：同一 stroke 批次内先画半透明光晕、再画墨色本体。 */
const selectedLineScene = {
  ...scene(false),
  layers: [{id: 'layer', opacity: 1, primitives: [
    {kind: 'stroke' as const, layerId: 'layer', points: [[10, 50], [90, 50]],
      color: [.188, .278, .8, .16], width: 20},
    {kind: 'stroke' as const, layerId: 'layer', points: [[10, 50], [90, 50]],
      color: [1, 0, 0, 1], width: 6}
  ]}],
  snap: []
};

/** 选中圆：同一 stroke 批次内先画半透明光晕、再画墨色描边；采样点在圆周上。 */
const selectedCircleScene = {
  ...scene(false),
  layers: [{id: 'layer', opacity: 1, primitives: [
    {kind: 'ellipse' as const, layerId: 'layer', center: [50, 50], radii: [28, 28],
      color: [.188, .278, .8, .16], width: 12},
    {kind: 'ellipse' as const, layerId: 'layer', center: [50, 50], radii: [28, 28],
      color: [1, 0, 0, 1], width: 4, fill: .12}
  ]}],
  snap: []
};

/** 捕捉标记：先画白色底、再画彩色十字；采样点位于十字中心。 */
const snapMarkerScene = {
  ...scene(false),
  layers: [],
  snap: [{kind: 'grid' as const, point: [50, 50]}]
};

/**
 * 跨后端回归：同一条直线先画或后画，填充/描边必须按场景顺序叠放。
 * Canvas2D 与 WebGPU 在 (50,50) 的像素应分别接近后绘制的颜色。
 */
test('fill/stroke painter order matches Canvas2D and WebGPU', async ({page}) => {
  await page.goto('/');
  const hasAdapter = await page.evaluate(async () => {
    if (!navigator.gpu) return false;
    return Boolean(await navigator.gpu.requestAdapter());
  });
  test.skip(!hasAdapter, '当前环境没有 WebGPU adapter');

  const samples = await page.evaluate(async ({fillLast, strokeLast, translucent, selectedLine, selectedCircle, marker}) => {
    const canvasUrl: string = '/canvas2d-renderer.ts';
    const gpuUrl: string = '/webgpu-renderer.ts';
    const {createCanvas2dRenderer} = await import(/* @vite-ignore */ canvasUrl);
    const {createWebGpuRenderer} = await import(/* @vite-ignore */ gpuUrl);
    const canvasPixel = (value: unknown, x = 100, y = 100): number[] => {
      const canvas = document.createElement('canvas');
      canvas.width = 200;
      canvas.height = 200;
      const renderer = createCanvas2dRenderer(canvas);
      renderer.resize(200, 200, 1);
      renderer.draw(value as never);
      const data = canvas.getContext('2d')!.getImageData(x, y, 1, 1).data;
      renderer.destroy();
      return [data[0], data[1], data[2]];
    };

    const gpuPixel = async (value: unknown, x = 100, y = 100): Promise<number[]> => {
      const canvas = document.createElement('canvas');
      canvas.width = 200;
      canvas.height = 200;
      canvas.style.cssText = 'position:fixed;left:0;top:0;width:200px;height:200px;z-index:9999';
      document.body.append(canvas);
      const renderer = await createWebGpuRenderer(canvas, {capture: true});
      renderer.resize(200, 200, 1);
      const internals = renderer as unknown as {
        device: GPUDevice;
        context: GPUCanvasContext;
        format: GPUTextureFormat;
      };
      renderer.draw(value as never);
      const bytesPerRow = Math.ceil(200 * 4 / 256) * 256;
      const buffer = internals.device.createBuffer({
        size: bytesPerRow * 200,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
      });
      const encoder = internals.device.createCommandEncoder();
      encoder.copyTextureToBuffer({texture: internals.context.getCurrentTexture()},
        {buffer, bytesPerRow, rowsPerImage: 200}, [200, 200]);
      internals.device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const data = new Uint8Array(buffer.getMappedRange());
      const offset = y * bytesPerRow + x * 4;
      const pixel = internals.format.startsWith('bgra')
        ? [data[offset + 2], data[offset + 1], data[offset]]
        : [data[offset], data[offset + 1], data[offset + 2]];
      buffer.unmap();
      buffer.destroy();
      renderer.destroy();
      canvas.remove();
      return pixel;
    };

    return {
      canvasFillLast: canvasPixel(fillLast),
      gpuFillLast: await gpuPixel(fillLast),
      canvasStrokeLast: canvasPixel(strokeLast),
      gpuStrokeLast: await gpuPixel(strokeLast),
      canvasTranslucent: canvasPixel(translucent),
      gpuTranslucent: await gpuPixel(translucent),
      canvasSelected: canvasPixel(selectedLine),
      gpuSelected: await gpuPixel(selectedLine),
      canvasCircle: canvasPixel(selectedCircle, 156, 100),
      gpuCircle: await gpuPixel(selectedCircle, 156, 100),
      canvasMarker: canvasPixel(marker),
      gpuMarker: await gpuPixel(marker)
    };
  }, {fillLast: scene(false), strokeLast: scene(true), translucent: translucentOverStrokeScene,
    selectedLine: selectedLineScene, selectedCircle: selectedCircleScene, marker: snapMarkerScene});

  const red = (pixel: number[]): boolean => pixel[0] > 180 && pixel[2] < 80;
  const blue = (pixel: number[]): boolean => pixel[2] > 180 && pixel[0] < 80;
  // 捕捉标记中心应是 snapColor（#d24a2a），而不是底层的白色。
  const snapInk = (pixel: number[]): boolean => pixel[0] > 150 && pixel[1] < 150 && pixel[2] < 120;
  // 填充后画 → 填充覆盖直线；直线后画 → 直线覆盖填充。
  expect(blue(samples.canvasFillLast)).toBe(true);
  expect(blue(samples.gpuFillLast)).toBe(true);
  expect(red(samples.canvasStrokeLast)).toBe(true);
  expect(red(samples.gpuStrokeLast)).toBe(true);
  // 半透明填充后画：红色描边必须透过填充仍然可见，且与 Canvas2D 的混合结果一致。
  expect(samples.gpuTranslucent[0]).toBeGreaterThan(150);
  expect(samples.gpuTranslucent[2]).toBeGreaterThan(10);
  for (let channel = 0; channel < 3; channel++) {
    expect(Math.abs(samples.gpuTranslucent[channel] - samples.canvasTranslucent[channel])).toBeLessThanOrEqual(16);
  }
  // 同一 stroke 批次内：墨色本体必须覆盖半透明光晕。
  expect(red(samples.canvasSelected)).toBe(true);
  expect(red(samples.gpuSelected)).toBe(true);
  expect(red(samples.canvasCircle)).toBe(true);
  expect(red(samples.gpuCircle)).toBe(true);
  // 同一 stroke 批次内：彩色十字必须覆盖白色底。
  expect(snapInk(samples.canvasMarker)).toBe(true);
  expect(snapInk(samples.gpuMarker)).toBe(true);
});
