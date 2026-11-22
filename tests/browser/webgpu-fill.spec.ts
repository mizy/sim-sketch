import {expect, test} from '@playwright/test';
import type {Page} from '@playwright/test';

const holePolygons = [[
  [[10, 10], [40, 10], [40, 40], [10, 40]],
  [[20, 20], [20, 30], [30, 30], [30, 20]]
]];
const concavePolygons = [[
  [[10, 10], [40, 10], [40, 20], [20, 20], [20, 40], [10, 40]]
]];

type Pixels = Record<string, number[]>;
type SamplePoints = Record<string, [number, number]>;
type ProbeWindow = {
  renderPrimitives: (primitives: unknown[], points: SamplePoints) => Promise<Pixels>;
  renderFill: (polygons: unknown) => Promise<Pixels>;
};

/**
 * 真 GPU 回归：必须用 --enable-unsafe-webgpu 启动（见 playwright.config.ts 的 webgpu project）。
 * 元素截图在 headless WebGPU 下会拿到黑帧，因此直接 copyTextureToBuffer 读回当前帧。
 * 环境没有 adapter 时跳过，避免 CI 无 GPU 直接红灯。
 */
async function installProbe(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    if (!navigator.gpu) return false;
    if (!await navigator.gpu.requestAdapter()) return false;
    const kernelUrl: string = '/kernel.ts';
    const {initGeometryKernel} = await import(/* @vite-ignore */ kernelUrl);
    await initGeometryKernel();
    const moduleUrl: string = '/webgpu-renderer.ts';
    const {createWebGpuRenderer} = await import(/* @vite-ignore */ moduleUrl);
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

    const colors = (data: Uint8Array, bytesPerRow: number, x: number, y: number): number[] => {
      const offset = y * bytesPerRow + x * 4;
      return internals.format.startsWith('bgra')
        ? [data[offset + 2], data[offset + 1], data[offset]]
        : [data[offset], data[offset + 1], data[offset + 2]];
    };

    const read = async (points: Record<string, [number, number]>): Promise<Record<string, number[]>> => {
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
      const pixels: Record<string, number[]> = {};
      for (const [name, [x, y]] of Object.entries(points)) {
        pixels[name] = colors(data, bytesPerRow, x, y);
      }
      buffer.unmap();
      buffer.destroy();
      return pixels;
    };

    let revision = 0;
    const render = async (primitives: unknown[],
      points: Record<string, [number, number]>): Promise<Record<string, number[]>> => {
      renderer.draw({
        revision: ++revision,
        viewport: {x: 0, y: 0, width: 100, height: 100, cssWidth: 200, cssHeight: 200, dpr: 1,
          pixelsPerWorldUnit: 2},
        background: {spacing: 24, radius: .1, origin: [1.4, 1.4],
          background: [1, 1, 1, 1], dot: [.9, .9, .9, 1]},
        reference: null,
        layers: [{id: 'layer', opacity: 1, primitives: primitives as never}],
        temporary: [], snap: []
      });
      return read(points);
    };
    (window as unknown as {renderPrimitives: typeof render}).renderPrimitives = render;
    (window as unknown as {renderFill: (polygons: unknown) => Promise<Record<string, number[]>>}).renderFill =
      polygons => render([{kind: 'fill', layerId: 'layer', polygons, color: [.8, .1, .1, 1], opacity: 1}],
        {inside: [30, 30], center: [50, 50], outside: [90, 90]});
    return true;
  });
}

test('WebGPU fills concave polygons and keeps holes empty', async ({page}) => {
  await page.goto('/');
  test.skip(!await installProbe(page), '当前环境没有 WebGPU adapter');

  const hole = await page.evaluate(async (initialPolygons: unknown) =>
    (window as unknown as ProbeWindow).renderFill(initialPolygons), holePolygons);
  const concave = await page.evaluate(async (polygons: unknown) =>
    (window as unknown as ProbeWindow).renderFill(polygons), concavePolygons);

  const redness = ([red, green]: number[]): number => red - green;
  expect(redness(hole.inside)).toBeGreaterThan(80);
  expect(redness(hole.center)).toBeLessThan(20);
  expect(redness(hole.outside)).toBeLessThan(20);
  // (15,15) 在 L 形实心区；(30,30) 在凹角外。
  expect(redness(concave.inside)).toBeGreaterThan(80);
  expect(redness(concave.outside)).toBeLessThan(20);
});

/**
 * 描边实例覆盖整个 AABB，半透明光晕也不能写深度。
 * 这些采样点覆盖 review 复现的三类遮挡：斜线 AABB、无填充圆、选中光晕/椭圆半透明填充。
 */
test('WebGPU keeps fills under stroke AABBs, circles and selected halos', async ({page}) => {
  await page.goto('/');
  test.skip(!await installProbe(page), '当前环境没有 WebGPU adapter');

  const result = await page.evaluate(async () => {
    const render = (window as unknown as ProbeWindow).renderPrimitives;
    const square = [[[[10, 10], [90, 10], [90, 90], [10, 90]]]];
    const fill = {kind: 'fill', layerId: 'layer', polygons: square, color: [.1, .2, .8, 1], opacity: 1};
    const stroke = await render([
      fill,
      {kind: 'stroke', layerId: 'layer', points: [[10, 10], [90, 90]], color: [1, 1, 1, 1], width: 2}
    ], {underAabb: [30, 160], underAabb2: [100, 140], onLine: [100, 100]});
    const circle = await render([
      fill,
      {kind: 'ellipse', layerId: 'layer', center: [50, 50], radii: [20, 20],
        color: [1, 1, 1, 1], width: 2, fill: 0}
    ], {center: [100, 100], ring: [100, 60]});
    const halo = await render([
      fill,
      {kind: 'ellipse', layerId: 'layer', center: [50, 50], radii: [30, 30],
        color: [1, 1, 1, .16], width: 7},
      {kind: 'ellipse', layerId: 'layer', center: [50, 50], radii: [30, 30],
        color: [1, 1, 1, 1], width: 2, fill: .12}
    ], {center: [100, 100], ring: [100, 44]});
    return {stroke, circle, halo};
  });

  const redness = ([red]: number[]): number => red;
  const blueness = ([, , blue]: number[]): number => blue;

  // 斜线 AABB 内、但远离线身的区域必须保留底层填充。
  expect(blueness(result.stroke.underAabb)).toBeGreaterThan(150);
  expect(blueness(result.stroke.underAabb2)).toBeGreaterThan(150);
  expect(redness(result.stroke.underAabb)).toBeLessThan(100);
  // 线身本身仍应被白色描边覆盖。
  expect(redness(result.stroke.onLine)).toBeGreaterThan(180);

  // 无填充圆不能遮住圆心下方的填充。
  expect(blueness(result.circle.center)).toBeGreaterThan(150);
  expect(redness(result.circle.center)).toBeLessThan(100);
  expect(redness(result.circle.ring)).toBeGreaterThan(180);

  // 选中光晕（半透明描边）与椭圆半透明填充都不能挤掉底层填充。
  expect(blueness(result.halo.center)).toBeGreaterThan(150);
  expect(redness(result.halo.center)).toBeLessThan(150);
  expect(blueness(result.halo.ring)).toBeGreaterThan(150);
  expect(redness(result.halo.ring)).toBeLessThan(150);
});

/**
 * 默认 demo 带 reference='demo'。参考图 pipeline 必须与 layer pass 的
 * depth24plus 附件兼容，否则第一次绘制参考图就会回退 Canvas2D。
 */
test('keeps the demo reference on the default WebGPU backend', async ({page}) => {
  const warnings: string[] = [];
  page.on('console', message => {
    if (message.type() === 'warning') warnings.push(message.text());
  });
  await page.goto('/');
  const hasAdapter = await page.evaluate(async () =>
    Boolean(navigator.gpu && await navigator.gpu.requestAdapter()));
  test.skip(!hasAdapter, '当前环境没有 WebGPU adapter');

  await expect(page.locator('#gpu-board')).toHaveAttribute('data-reference', 'demo', {timeout: 5000});
  await expect(page.locator('#board')).toHaveAttribute('data-renderer', 'webgpu');
  await page.waitForTimeout(500);
  await expect(page.locator('#board')).toHaveAttribute('data-renderer', 'webgpu');
  expect(warnings.filter(text => text.includes('WebGPU 渲染器运行失败'))).toEqual([]);
});

/**
 * 参考图生命周期回归：demo → 新建 → demo 必须在同一 WebGPU renderer 上恢复参考图。
 * 旧实现只销毁 texture、不清 requestedReference，第二次 demo 会命中提前返回而静默丢图。
 */
test('restores the same reference after new/demo round trips', async ({page}) => {
  const warnings: string[] = [];
  page.on('console', message => {
    if (message.type() === 'warning') warnings.push(message.text());
  });
  await page.goto('/');
  const hasAdapter = await page.evaluate(async () =>
    Boolean(navigator.gpu && await navigator.gpu.requestAdapter()));
  test.skip(!hasAdapter, '当前环境没有 WebGPU adapter');

  const canvas = page.locator('#gpu-board');
  const board = page.locator('#board');
  const choose = async (id: 'new' | 'demo'): Promise<void> => {
    await page.locator('summary[title="文件菜单"]').click();
    await page.locator(`#${id}`).click();
  };

  await expect(canvas).toHaveAttribute('data-reference', 'demo', {timeout: 5000});
  await expect(board).toHaveAttribute('data-renderer', 'webgpu');

  await choose('new');
  await expect.poll(() => canvas.getAttribute('data-reference')).toBeNull();
  await expect(board).toHaveAttribute('data-renderer', 'webgpu');

  await choose('demo');
  await expect(canvas).toHaveAttribute('data-reference', 'demo', {timeout: 5000});
  await expect(board).toHaveAttribute('data-renderer', 'webgpu');
  expect(warnings.filter(text => text.includes('WebGPU 渲染器运行失败'))).toEqual([]);
});

/**
 * 失败注入：WebGPU 已初始化但 Wasm 404/CSP 失败时，填充不能永久消失。
 * Host 应收到 onError 并回退到 Canvas2D/SVG，而不是留下只有描边的画面。
 */
test('falls back when the wasm kernel fails during a WebGPU fill', async ({page}) => {
  await page.addInitScript(async () => {
    const registrations = await navigator.serviceWorker?.getRegistrations?.() ?? [];
    await Promise.all(registrations.map(registration => registration.unregister()));
    const keys = await caches.keys();
    await Promise.all(keys.map(key => caches.delete(key)));
    // 本次测试不走 SW，否则 cache-first 会掩盖人为制造的 wasm 失败。
    Object.defineProperty(navigator, 'serviceWorker', {configurable: true, value: undefined});
  });
  await page.route(/\.wasm(\?.*)?$/, route => route.fulfill({
    status: 200, contentType: 'application/wasm', body: 'not wasm'
  }));
  await page.goto('/');
  await expect(page.locator('main')).not.toHaveAttribute('inert', '');
  const backend = await page.locator('#board').getAttribute('data-renderer');
  test.skip(backend !== 'webgpu', '当前环境没有 WebGPU adapter，无法触发运行期内核失败');

  await page.locator('[data-tool="rect"]').click();
  const box = await page.locator('#board').boundingBox();
  if (!box) throw new Error('画板没有尺寸');
  await page.mouse.move(box.x + 200, box.y + 150);
  await page.mouse.down();
  await page.mouse.move(box.x + 360, box.y + 280, {steps: 5});
  await page.mouse.up();

  await expect(page.locator('#board')).toHaveAttribute('data-renderer', /^(canvas2d|svg)$/);
  await expect(page.locator('[data-shape-id]')).toHaveCount(1);
});
