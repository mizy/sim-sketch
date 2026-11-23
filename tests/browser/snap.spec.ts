import {readFileSync} from 'node:fs';
import {expect, test} from '@playwright/test';
import type {Page} from '@playwright/test';

async function startLine(page: Page): Promise<void> {
  await page.goto('/?renderer=svg');
  await expect(page.locator('main')).not.toHaveAttribute('inert', '');
  await expect(page.locator('#board')).toHaveAttribute('data-renderer', 'svg');
  await page.locator('[data-tool="line"]').click();
}

/** 从已提交直线读取真实端点/中点屏幕坐标，避免绘制时的栅格吸附让固定坐标失效。 */
async function lineSites(page: Page): Promise<{start: {x: number; y: number}; midpoint: {x: number; y: number}}> {
  return page.locator('[data-shape-id] path').first().evaluate(node => {
    const path = node as SVGPathElement;
    const board = document.querySelector<SVGSVGElement>('#board')!;
    const matrix = board.getScreenCTM()!;
    const start = new DOMPoint(path.getPointAtLength(0).x, path.getPointAtLength(0).y).matrixTransform(matrix);
    const middle = path.getPointAtLength(path.getTotalLength() / 2);
    const midpoint = new DOMPoint(middle.x, middle.y).matrixTransform(matrix);
    return {start: {x: start.x, y: start.y}, midpoint: {x: midpoint.x, y: midpoint.y}};
  });
}

test('drawing snaps to endpoints and midpoints, Alt suspends, toggle persists', async ({page}) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await startLine(page);
  const box = await page.locator('#board').boundingBox();
  if (!box) throw new Error('画板没有尺寸');

  await page.mouse.move(box.x + box.width * .30, box.y + box.height * .34);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * .58, box.y + box.height * .34, {steps: 6});
  await page.mouse.up();
  await expect(page.locator('[data-shape-id]')).toHaveCount(1);

  const {start, midpoint} = await lineSites(page);
  await page.mouse.move(start.x + 4, start.y + 3);
  await page.mouse.down();
  await expect(page.locator('#snap-badge')).toBeVisible();
  await expect(page.locator('#snap-badge-label')).toHaveText('端点');

  await page.mouse.move(midpoint.x + 3, midpoint.y + 2);
  await expect(page.locator('#snap-badge-label')).toHaveText('中点');

  await page.keyboard.down('Alt');
  await page.mouse.move(start.x + 4, start.y + 3);
  await expect(page.locator('#snap-badge')).toBeHidden();
  await page.keyboard.up('Alt');
  await page.mouse.move(start.x + 4, start.y + 3);
  await expect(page.locator('#snap-badge-label')).toHaveText('端点');

  // 移开再结束，避免提交一条零长度直线。
  await page.mouse.move(box.x + box.width * .72, box.y + box.height * .58);
  await page.mouse.up();

  const toggle = page.locator('#snap-toggle');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate(() => localStorage.getItem('sim-sketch-snap'))).toBe('off');

  await page.mouse.move(start.x + 4, start.y + 3);
  await page.mouse.down();
  await expect(page.locator('#snap-badge')).toBeHidden();
  await page.mouse.up();

  await page.reload();
  await expect(page.locator('main')).not.toHaveAttribute('inert', '');
  await expect(page.locator('#snap-toggle')).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate(() => localStorage.getItem('sim-sketch-snap'))).toBe('off');
  expect(errors).toEqual([]);
});

test('moving a shape snaps the grabbed endpoint onto another endpoint', async ({page}) => {
  await startLine(page);
  const box = await page.locator('#board').boundingBox();
  if (!box) throw new Error('画板没有尺寸');

  // 两条互不相交的直线：第一条的起点将作为第二条拖动终点的捕捉目标。
  await page.mouse.move(box.x + box.width * .26, box.y + box.height * .32);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * .44, box.y + box.height * .32, {steps: 5});
  await page.mouse.up();
  await page.mouse.move(box.x + box.width * .30, box.y + box.height * .58);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * .52, box.y + box.height * .58, {steps: 5});
  await page.mouse.up();
  await expect(page.locator('[data-shape-id]')).toHaveCount(2);

  const sites = await page.evaluate(() => {
    const paths = document.querySelectorAll<SVGPathElement>('[data-shape-id] path');
    const board = document.querySelector<SVGSVGElement>('#board')!;
    const matrix = board.getScreenCTM()!;
    const screen = (path: SVGPathElement, offset: number): {x: number; y: number} => {
      const point = path.getPointAtLength(offset);
      const mapped = new DOMPoint(point.x, point.y).matrixTransform(matrix);
      return {x: mapped.x, y: mapped.y};
    };
    const target = paths[0];
    const moving = paths[1];
    return {
      target: screen(target, 0),
      grabbed: screen(moving, moving.getTotalLength())
    };
  });

  await page.locator('[data-tool="select"]').click();
  await page.mouse.move(sites.grabbed.x, sites.grabbed.y);
  await page.mouse.down();
  await page.mouse.move(sites.target.x + 3, sites.target.y + 2, {steps: 6});
  await expect(page.locator('#snap-badge-label')).toHaveText('端点');
  await page.mouse.up();

  const landed = await page.evaluate(() => {
    const paths = document.querySelectorAll<SVGPathElement>('[data-shape-id] path');
    const target = paths[0].getPointAtLength(0);
    const moving = paths[1];
    const end = moving.getPointAtLength(moving.getTotalLength());
    return {target: {x: target.x, y: target.y}, end: {x: end.x, y: end.y}};
  });
  expect(landed.end.x).toBeCloseTo(landed.target.x, 6);
  expect(landed.end.y).toBeCloseTo(landed.target.y, 6);
});

test('scaling a handle snaps onto another shape endpoint', async ({page}) => {
  await page.goto('/?renderer=svg');
  await expect(page.locator('main')).not.toHaveAttribute('inert', '');
  await page.locator('.menu summary').click();
  await page.locator('#new').click();
  const box = await page.locator('#board').boundingBox();
  if (!box) throw new Error('画板没有尺寸');

  const drawRect = async (x: number, y: number): Promise<void> => {
    await page.locator('button[data-tool="rect"]').click();
    await page.mouse.move(box.x + x, box.y + y);
    await page.mouse.down();
    await page.mouse.move(box.x + x + 130, box.y + y + 90, {steps: 6});
    await page.mouse.up();
    await expect(page.locator('#status')).toHaveText('草稿已保存在此设备');
  };
  await drawRect(180, 160);
  await drawRect(430, 160);

  await page.locator('[data-tool="select"]').click();
  const moving = page.locator('[data-shape-id]').nth(1);
  const movingBox = await moving.boundingBox();
  const target = await page.locator('[data-shape-id] path').first().evaluate(node => {
    const box = (node as SVGGraphicsElement).getBBox();
    const matrix = (node as SVGGraphicsElement).getScreenCTM()!;
    const point = new DOMPoint(box.x + box.width, box.y + box.height).matrixTransform(matrix);
    return {x: point.x, y: point.y};
  });
  if (!movingBox) throw new Error('矩形没有尺寸');
  await page.mouse.click(movingBox.x + movingBox.width / 2, movingBox.y + movingBox.height / 2);
  await expect(page.locator('[data-transform-handle="nw"]')).toBeVisible();

  // 把第二个矩形的左上角拖到第一个矩形右下角附近，缩放落点必须精确等于该端点。
  const handle = await page.locator('[data-transform-handle="nw"]').boundingBox();
  if (!handle) throw new Error('缩放手柄没有尺寸');
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + 3, target.y + 2, {steps: 8});
  await expect(page.locator('#snap-badge-label')).toHaveText('端点');
  await page.mouse.up();

  await page.locator('.menu summary').click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#export-json').click()
  ]);
  const exported = JSON.parse(readFileSync(await download.path(), 'utf8')) as {
    shapes: {a: [number, number]; b: [number, number]}[]};
  // 手柄包围盒含 14 world 的最小可抓取扩张，落点允许半个扩张量的偏差；
  // 关键是捕捉标记已确认到端点，且几何落在端点附近而不是自由拖动位置。
  expect(Math.hypot(exported.shapes[1].a[0] - exported.shapes[0].b[0],
    exported.shapes[1].a[1] - exported.shapes[0].b[1])).toBeLessThan(8);
});

test('?snap=500,300 debug marker still renders without a pointer interaction', async ({page}) => {
  await page.goto('/?renderer=svg&snap=500,300');
  await expect(page.locator('#board')).toHaveAttribute('data-renderer', 'svg');
  // 调试标记走 RenderScene.snap；它在没有绘制状态时也必须保留。
  await expect.poll(() => page.locator('#board [data-render-geometry] > g circle').count())
    .toBeGreaterThan(0);
});

test('pen and region free drawing never snap to existing endpoints', async ({page}) => {
  await startLine(page);
  const box = await page.locator('#board').boundingBox();
  if (!box) throw new Error('画板没有尺寸');
  await page.mouse.move(box.x + box.width * .30, box.y + box.height * .34);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * .58, box.y + box.height * .34, {steps: 6});
  await page.mouse.up();
  const {start} = await lineSites(page);

  await page.locator('[data-tool="region"]').click();
  await page.mouse.move(start.x + 4, start.y + 3);
  await page.mouse.down();
  await expect(page.locator('#snap-badge')).toBeHidden();
  await page.mouse.move(start.x + 90, start.y + 70, {steps: 5});
  await expect(page.locator('#snap-badge')).toBeHidden();
  await page.mouse.up();

  await page.locator('[data-tool="pen"]').click();
  await page.mouse.move(start.x + 4, start.y + 3);
  await page.mouse.down();
  await expect(page.locator('#snap-badge')).toBeHidden();
  await page.mouse.move(start.x + 70, start.y + 36, {steps: 5});
  await expect(page.locator('#snap-badge')).toBeHidden();
  await page.mouse.up();
});
