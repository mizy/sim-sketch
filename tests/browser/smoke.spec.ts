import {expect, test} from '@playwright/test';

test('draws, selects and persists a rectangle after reload', async ({page}) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));

  await page.goto('/');
  await expect(page.locator('main')).not.toHaveAttribute('inert', '');
  // 默认 auto：无 WebGPU 的 CI/headless 环境必须落到 Canvas2D，而不是 SVG。
  await expect(page.locator('#board')).toHaveAttribute('data-renderer', /^(webgpu|canvas2d)$/);

  await page.locator('[data-tool="rect"]').click();
  const box = await page.locator('#board').boundingBox();
  if (!box) throw new Error('画板没有尺寸');
  await page.mouse.move(box.x + 200, box.y + 150);
  await page.mouse.down();
  await page.mouse.move(box.x + 360, box.y + 280, {steps: 5});
  await page.mouse.up();
  await expect(page.locator('[data-shape-id]')).toHaveCount(1);

  await page.locator('[data-tool="select"]').click();
  await page.mouse.click(box.x + 280, box.y + 215);
  await expect(page.locator('#shape-actions')).toBeVisible();
  // 选中操作条必须贴着图形，而不是钉在画板顶部。同一帧读取两者，避免布局漂移。
  const placement = await page.evaluate(() => {
    const shape = document.querySelector('[data-shape-id]')!.getBoundingClientRect();
    const actions = document.querySelector<HTMLElement>('#shape-actions')!.getBoundingClientRect();
    return {shape: shape.toJSON(), actions: actions.toJSON()};
  });
  expect(placement.actions.y + placement.actions.height).toBeLessThanOrEqual(placement.shape.y + 1);
  expect(Math.abs(placement.actions.x + placement.actions.width / 2 -
    (placement.shape.x + placement.shape.width / 2))).toBeLessThan(80);
  await expect(page.locator('#status')).toHaveText('草稿已保存在此设备');

  await page.reload();
  await expect(page.locator('[data-shape-id]')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('replacing the canvas drops an unfinished arc before the next click', async ({page}) => {
  await page.goto('/?renderer=canvas2d');
  await expect(page.locator('#board')).toHaveAttribute('data-renderer', 'canvas2d');
  const box = await page.locator('#board').boundingBox();
  if (!box) throw new Error('画板没有尺寸');

  // 先拖出圆弧弦，进入 pendingArc：此时还没有提交任何 shape。
  await page.locator('[data-tool="arc"]').click();
  await page.mouse.move(box.x + 300, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + 420, box.y + 200, {steps: 4});
  await page.mouse.up();
  await expect(page.locator('[data-shape-id]')).toHaveCount(0);

  // 新建空白必须丢弃旧画布的 pendingArc，否则下一次点击会 finishArc 写进新项目。
  await page.locator('.menu summary').click();
  await page.locator('#new').click();
  await page.mouse.click(box.x + 350, box.y + 300);
  await expect(page.locator('[data-shape-id]')).toHaveCount(0);
});

test('Canvas2D context loss reports to the host and falls back to SVG', async ({page}) => {
  await page.goto('/?renderer=canvas2d');
  await expect(page.locator('#board')).toHaveAttribute('data-renderer', 'canvas2d');
  await page.evaluate(() => {
    const canvas = document.querySelector('#gpu-board');
    canvas?.dispatchEvent(new Event('contextlost', {cancelable: true}));
  });
  await expect(page.locator('#board')).toHaveAttribute('data-renderer', 'svg');
});

test('falls back to SVG when both WebGPU and Canvas2D are unavailable', async ({page}) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'gpu', {configurable: true, value: undefined});
    const original = HTMLCanvasElement.prototype.getContext as
      (this: HTMLCanvasElement, type: string, ...args: unknown[]) => unknown;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string,
      ...args: unknown[]) {
      if (type === '2d') return null;
      return original.call(this, type, ...args);
    } as typeof HTMLCanvasElement.prototype.getContext;
  });

  await page.goto('/');
  await expect(page.locator('main')).not.toHaveAttribute('inert', '');
  await expect(page.locator('#board')).toHaveAttribute('data-renderer', 'svg');

  await page.locator('[data-tool="rect"]').click();
  const box = await page.locator('#board').boundingBox();
  if (!box) throw new Error('画板没有尺寸');
  await page.mouse.move(box.x + 220, box.y + 160);
  await page.mouse.down();
  await page.mouse.move(box.x + 380, box.y + 280, {steps: 5});
  await page.mouse.up();
  await expect(page.locator('[data-shape-id]')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('Canvas2D paints real fill pixels and keeps holes empty', async ({page}) => {
  await page.goto('/?renderer=canvas2d');
  await expect(page.locator('#board')).toHaveAttribute('data-renderer', 'canvas2d');

  const pixels = await page.evaluate(async () => {
    const moduleUrl: string = '/canvas2d-renderer.ts';
    const {createCanvas2dRenderer} = await import(/* @vite-ignore */ moduleUrl);
    const paint = (polygons: unknown) => {
      const canvas = document.createElement('canvas');
      canvas.width = 200;
      canvas.height = 200;
      const renderer = createCanvas2dRenderer(canvas);
      renderer.resize(200, 200, 1);
      renderer.draw({
        revision: 1,
        viewport: {x: 0, y: 0, width: 100, height: 100, cssWidth: 200, cssHeight: 200, dpr: 1,
          pixelsPerWorldUnit: 2},
        background: {spacing: 24, radius: .1, origin: [1.4, 1.4],
          background: [1, 1, 1, 1], dot: [.9, .9, .9, 1]},
        reference: null,
        layers: [{id: 'layer', opacity: 1, primitives: [
          {kind: 'fill', layerId: 'layer', polygons, color: [.8, .1, .1, 1], opacity: 1}
        ]}],
        temporary: [], snap: []
      });
      const context = canvas.getContext('2d')!;
      const sample = (x: number, y: number) => [...context.getImageData(x, y, 1, 1).data];
      const result = {inside: sample(30, 30), hole: sample(50, 50), outside: sample(90, 90)};
      renderer.destroy();
      return result;
    };

    const squareWithHole = paint([[
      [[10, 10], [40, 10], [40, 40], [10, 40]],
      [[20, 20], [20, 30], [30, 30], [30, 20]]
    ]]);
    const concave = paint([[
      [[10, 10], [40, 10], [40, 20], [20, 20], [20, 40], [10, 40]]
    ]]);
    return {squareWithHole, concave};
  });

  const redness = ([red, green]: number[]): number => red - green;
  expect(redness(pixels.squareWithHole.inside)).toBeGreaterThan(80);
  expect(redness(pixels.squareWithHole.hole)).toBeLessThan(20);
  expect(redness(pixels.squareWithHole.outside)).toBeLessThan(20);
  // 世界坐标 (15,15) 在 L 形实心区；世界坐标 (45,45) 在凹角外。
  expect(redness(pixels.concave.inside)).toBeGreaterThan(80);
  expect(redness(pixels.concave.outside)).toBeLessThan(20);
});

test('falls back to Canvas2D when WebGPU is disabled', async ({page}) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'gpu', {configurable: true, value: undefined});
  });

  await page.goto('/');
  await expect(page.locator('main')).not.toHaveAttribute('inert', '');
  await expect(page.locator('#board')).toHaveAttribute('data-renderer', 'canvas2d');

  await page.locator('[data-tool="rect"]').click();
  const box = await page.locator('#board').boundingBox();
  if (!box) throw new Error('画板没有尺寸');
  await page.mouse.move(box.x + 240, box.y + 180);
  await page.mouse.down();
  await page.mouse.move(box.x + 420, box.y + 300, {steps: 5});
  await page.mouse.up();
  await expect(page.locator('[data-shape-id]')).toHaveCount(1);
  expect(errors).toEqual([]);
});

/**
 * 延迟内核下按 Esc：布尔操作的交互令牌必须失效，
 * 不能让旧选择在内核就绪后替换成新 path。
 */
test('Escape cancels a boolean that is still waiting for the kernel', async ({page}) => {
  await page.addInitScript(async () => {
    const registrations = await navigator.serviceWorker?.getRegistrations?.() ?? [];
    await Promise.all(registrations.map(registration => registration.unregister()));
    const keys = await caches.keys();
    await Promise.all(keys.map(key => caches.delete(key)));
    // 避免 SW 的 cache-first 掩盖人为延迟。
    Object.defineProperty(navigator, 'serviceWorker', {configurable: true, value: undefined});
  });
  await page.route(/\.wasm(\?.*)?$/, async route => {
    await new Promise(resolve => setTimeout(resolve, 2000));
    await route.fulfill({response: await route.fetch()});
  });
  await page.goto('/');
  await expect(page.locator('main')).not.toHaveAttribute('inert', '');
  const box = await page.locator('#board').boundingBox();
  if (!box) throw new Error('画板没有尺寸');

  await page.locator('[data-tool="rect"]').click();
  // 两个矩形刻意不重叠，选择时点击各自中心才不会误中相邻图形的命中代理。
  await page.mouse.move(box.x + 140, box.y + 120);
  await page.mouse.down();
  await page.mouse.move(box.x + 230, box.y + 210, {steps: 4});
  await page.mouse.up();
  // 避开默认项目里的示例标注命中代理。
  await page.mouse.move(box.x + 600, box.y + 500);
  await page.mouse.down();
  await page.mouse.move(box.x + 690, box.y + 590, {steps: 4});
  await page.mouse.up();
  await expect(page.locator('[data-shape-id]')).toHaveCount(2);

  await page.locator('[data-tool="select"]').click();
  const shapes = page.locator('[data-shape-id]');
  const first = await shapes.nth(0).boundingBox();
  const second = await shapes.nth(1).boundingBox();
  if (!first || !second) throw new Error('图形没有包围盒');
  await page.mouse.click(first.x + first.width / 2, first.y + first.height / 2);
  await page.keyboard.down('Shift');
  await page.mouse.click(second.x + second.width / 2, second.y + second.height / 2);
  await page.keyboard.up('Shift');
  await expect(page.locator('#shape-count')).toHaveText('已选 2 个图形');
  const union = page.locator('[data-boolean="union"]');
  await expect(union).toBeEnabled();
  await union.click();
  await expect(page.locator('#notice')).toHaveText('正在计算布尔结果…');

  await page.keyboard.press('Escape');
  await expect(page.locator('#notice')).toHaveText('画布已变化，布尔操作已取消。', {timeout: 6000});
  await expect(page.locator('[data-shape-id]')).toHaveCount(2);
});

/**
 * 取消按钮也是画布交互：必须递增 interactionEpoch，
 * 否则内核就绪后仍会提交点击取消前的旧选择。
 */
test('shape-clear cancels a boolean that is still waiting for the kernel', async ({page}) => {
  await page.addInitScript(async () => {
    const registrations = await navigator.serviceWorker?.getRegistrations?.() ?? [];
    await Promise.all(registrations.map(registration => registration.unregister()));
    const keys = await caches.keys();
    await Promise.all(keys.map(key => caches.delete(key)));
    Object.defineProperty(navigator, 'serviceWorker', {configurable: true, value: undefined});
  });
  await page.route(/\.wasm(\?.*)?$/, async route => {
    await new Promise(resolve => setTimeout(resolve, 2000));
    await route.fulfill({response: await route.fetch()});
  });
  await page.goto('/');
  await expect(page.locator('main')).not.toHaveAttribute('inert', '');
  const box = await page.locator('#board').boundingBox();
  if (!box) throw new Error('画板没有尺寸');

  await page.locator('[data-tool="rect"]').click();
  await page.mouse.move(box.x + 140, box.y + 120);
  await page.mouse.down();
  await page.mouse.move(box.x + 230, box.y + 210, {steps: 4});
  await page.mouse.up();
  await page.mouse.move(box.x + 600, box.y + 500);
  await page.mouse.down();
  await page.mouse.move(box.x + 690, box.y + 590, {steps: 4});
  await page.mouse.up();
  await expect(page.locator('[data-shape-id]')).toHaveCount(2);

  await page.locator('[data-tool="select"]').click();
  const shapes = page.locator('[data-shape-id]');
  const first = await shapes.nth(0).boundingBox();
  const second = await shapes.nth(1).boundingBox();
  if (!first || !second) throw new Error('图形没有包围盒');
  await page.mouse.click(first.x + first.width / 2, first.y + first.height / 2);
  await page.keyboard.down('Shift');
  await page.mouse.click(second.x + second.width / 2, second.y + second.height / 2);
  await page.keyboard.up('Shift');
  await expect(page.locator('#shape-count')).toHaveText('已选 2 个图形');

  const union = page.locator('[data-boolean="union"]');
  await expect(union).toBeEnabled();
  await union.click();
  await expect(page.locator('#notice')).toHaveText('正在计算布尔结果…');

  await page.locator('#shape-clear').click();
  await expect(page.locator('#notice')).toHaveText('画布已变化，布尔操作已取消。', {timeout: 6000});
  await expect(page.locator('[data-shape-id]')).toHaveCount(2);
});
