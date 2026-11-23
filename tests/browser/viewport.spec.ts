import {readFileSync} from 'node:fs';
import {expect, test} from '@playwright/test';
import type {Page} from '@playwright/test';

async function viewBox(page: Page): Promise<number[]> {
  const value = await page.locator('#board').getAttribute('viewBox');
  if (!value) throw new Error('画板没有 viewBox');
  return value.split(/\s+/).map(Number);
}

interface ExportJson {
  viewBox: number[];
  shapes: Array<{type: string; a?: [number, number]; b?: [number, number]}>;
}

async function exportJson(page: Page): Promise<ExportJson> {
  await page.locator('.menu summary').click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#export-json').click()
  ]);
  return JSON.parse(readFileSync(await download.path(), 'utf8')) as ExportJson;
}

function containsRect(viewBox: number[], a: [number, number], b: [number, number]): boolean {
  const [x, y, width, height] = viewBox;
  return a[0] >= x && a[1] >= y && b[0] <= x + width && b[1] <= y + height;
}

test('wheel zoom is anchored and clamped; space pan and F fit do not leak into exports', async ({page}) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/?renderer=canvas2d');
  await expect(page.locator('main')).not.toHaveAttribute('inert', '');
  await expect(page.locator('#board')).toHaveAttribute('data-renderer', 'canvas2d');
  // 空画布避免示例标注的命中代理盖住新绘制的矩形。
  await page.locator('.menu summary').click();
  await page.locator('#new').click();
  const box = await page.locator('#board').boundingBox();
  if (!box) throw new Error('画板没有尺寸');
  const center = {x: box.x + box.width / 2, y: box.y + box.height / 2};

  // 0 回到 100%：world 宽度等于画板 CSS 宽度，当前视图中心保持不变。
  const beforeReset = await viewBox(page);
  await page.keyboard.press('0');
  await expect(page.locator('#zoom-reset')).toHaveText('100%');
  const hundred = await viewBox(page);
  expect(hundred[2]).toBeCloseTo(box.width, 3);
  expect(hundred[0] + hundred[2] / 2).toBeCloseTo(beforeReset[0] + beforeReset[2] / 2, 3);
  expect(hundred[1] + hundred[3] / 2).toBeCloseTo(beforeReset[1] + beforeReset[3] / 2, 3);

  // 滚轮缩放到上下限。
  await page.mouse.move(center.x, center.y);
  for (let index = 0; index < 8; index++) await page.mouse.wheel(0, -400);
  await expect(page.locator('#zoom-reset')).toHaveText('800%');
  for (let index = 0; index < 14; index++) await page.mouse.wheel(0, 400);
  await expect(page.locator('#zoom-reset')).toHaveText('10%');
  await page.keyboard.press('0');
  await expect(page.locator('#zoom-reset')).toHaveText('100%');

  // 放大后绘制、点选与拖动仍使用同一套屏幕↔世界换算。
  await page.mouse.move(center.x, center.y);
  await page.mouse.wheel(0, -300);
  await expect(page.locator('#zoom-reset')).not.toHaveText('100%');
  await page.locator('[data-tool="rect"]').click();
  await page.mouse.move(box.x + box.width * .30, box.y + box.height * .30);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * .40, box.y + box.height * .40, {steps: 5});
  await page.mouse.up();
  await expect(page.locator('[data-shape-id]')).toHaveCount(1);

  await page.locator('[data-tool="select"]').click();
  await page.mouse.click(box.x + box.width * .35, box.y + box.height * .35);
  await expect(page.locator('#shape-actions')).toBeVisible();
  const beforeDrag = await page.locator('[data-shape-id] path').first().getAttribute('d');
  await page.mouse.move(box.x + box.width * .35, box.y + box.height * .35);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * .35 + 40, box.y + box.height * .35 + 24, {steps: 5});
  await page.mouse.up();
  expect(await page.locator('[data-shape-id] path').first().getAttribute('d')).not.toBe(beforeDrag);
  await expect(page.locator('[data-shape-id]')).toHaveCount(1);

  // 空格拖拽只平移临时视口，不新增图形；缩放读数不变。
  const zoomBeforePan = await page.locator('#zoom-reset').textContent();
  const beforePan = await viewBox(page);
  await page.keyboard.down('Space');
  await page.mouse.move(box.x + box.width * .8, box.y + box.height * .8);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * .8 + 60, box.y + box.height * .8 + 30, {steps: 5});
  await page.mouse.up();
  await page.keyboard.up('Space');
  const afterPan = await viewBox(page);
  expect(afterPan[0]).not.toBeCloseTo(beforePan[0], 3);
  expect(afterPan[1]).not.toBeCloseTo(beforePan[1], 3);
  expect(await page.locator('#zoom-reset').textContent()).toBe(zoomBeforePan);
  await expect(page.locator('[data-shape-id]')).toHaveCount(1);

  // 导出使用内容包围盒，不包含实时 zoom/pan。
  const exported = await exportJson(page);
  const rect = exported.shapes[0];
  if (rect?.type !== 'rect' || !rect.a || !rect.b) throw new Error('导出的矩形几何缺失');
  expect(exported.viewBox).not.toEqual(afterPan);
  expect(containsRect(exported.viewBox, rect.a, rect.b)).toBe(true);

  // F 重新适配：只框内容，视图比例仍匹配窗口，内容完整可见。
  await page.keyboard.press('f');
  const fitted = await viewBox(page);
  expect(fitted[2] / fitted[3]).toBeCloseTo(box.width / box.height, 6);
  expect(containsRect(fitted, rect.a, rect.b)).toBe(true);
  await expect(page.locator('[data-shape-id]')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('Space on a focused zoom button keeps its native activation', async ({page}) => {
  await page.goto('/?renderer=svg');
  await expect(page.locator('main')).not.toHaveAttribute('inert', '');
  await page.locator('.menu summary').click();
  await page.locator('#new').click();
  await page.keyboard.press('0');
  await expect(page.locator('#zoom-reset')).toHaveText('100%');

  await page.locator('#zoom-in').focus();
  await page.keyboard.press('Space');
  // 空白画布上的 Space 才是平移手势；聚焦按钮时 Space 必须触发按钮本身。
  await expect(page.locator('#zoom-reset')).toHaveText('120%');
});

test('Space on a focused select keeps native behavior and does not start canvas pan', async ({page}) => {
  await page.goto('/?renderer=svg');
  await expect(page.locator('main')).not.toHaveAttribute('inert', '');
  await page.locator('.menu summary').click();
  await page.locator('#new').click();
  await page.locator('#toggle-inspector').click();
  const select = page.locator('#object-layer');
  await select.focus();
  await page.keyboard.press('Space');
  await expect(page.locator('#board')).not.toHaveAttribute('data-pan', 'active');
});

test('selection action bar keeps following the object after wheel zoom and space pan', async ({page}) => {
  await page.goto('/?renderer=svg');
  await expect(page.locator('main')).not.toHaveAttribute('inert', '');
  await page.locator('.menu summary').click();
  await page.locator('#new').click();
  const box = await page.locator('#board').boundingBox();
  if (!box) throw new Error('画板没有尺寸');
  const center = {x: box.x + box.width / 2, y: box.y + box.height / 2};

  await page.locator('[data-tool="rect"]').click();
  await page.mouse.move(box.x + 300, box.y + 220);
  await page.mouse.down();
  await page.mouse.move(box.x + 430, box.y + 310, {steps: 6});
  await page.mouse.up();
  await page.locator('[data-tool="select"]').click();
  await page.mouse.click(box.x + 365, box.y + 265);
  await expect(page.locator('#shape-actions')).toBeVisible();

  const alignment = () => page.evaluate(() => {
    const object = document.querySelector('#board [data-shape-id]')?.getBoundingClientRect();
    const actions = document.querySelector<HTMLElement>('#shape-actions')?.getBoundingClientRect();
    if (!object || !actions) return Number.POSITIVE_INFINITY;
    const horizontal = Math.abs((object.left + object.width / 2) - (actions.left + actions.width / 2));
    const verticalGap = Math.min(Math.abs(object.top - actions.bottom), Math.abs(actions.top - object.bottom));
    return Math.max(horizontal, verticalGap);
  });
  await expect.poll(alignment).toBeLessThan(48);

  // 滚轮缩放后图形移动并变大，操作条必须重新投影到对象上方。
  await page.mouse.move(center.x, center.y);
  await page.mouse.wheel(0, -300);
  await expect(page.locator('#zoom-reset')).not.toHaveText('100%');
  await expect.poll(alignment).toBeLessThan(48);

  // 空格平移只改 viewBox；操作条同样跟随，而不是留在屏幕原位。
  await page.keyboard.down('Space');
  await page.mouse.move(center.x - 120, center.y);
  await page.mouse.down();
  await page.mouse.move(center.x - 20, center.y + 40, {steps: 6});
  await page.mouse.up();
  await page.keyboard.up('Space');
  await expect.poll(alignment).toBeLessThan(48);
});

test('F and reload fit a stored rotated region without clipping it', async ({page}) => {
  // 圈选不提供旋转手势，但旧草稿仍可能带 rotation；直接写入 IndexedDB 保留适配回归。
  await page.addInitScript(() => {
    const request = indexedDB.open('sim-sketch', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('projects');
    return new Promise<void>((resolve, reject) => {
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('projects', 'readwrite');
        tx.objectStore('projects').put({
          reference: null,
          layers: [{id: 'layer-default', name: '图层 1', opacity: 1}],
          shapes: [],
          marks: [{
            id: 'rotated-region', shape: 'region', kind: 'note', label: '', value: null, unit: '',
            direction: '', question: '', confirmed: false, source: 'manual', layerId: 'layer-default',
            a: [130, 280], b: [830, 320], width: 4, rotation: 90
          }]
        }, 'draft');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      };
      request.onerror = () => reject(request.error);
    });
  });
  await page.goto('/?renderer=svg');
  await expect(page.locator('main')).not.toHaveAttribute('inert', '');
  await expect(page.locator('[data-id] path')).toHaveCount(1);

  await page.locator('[data-tool="select"]').click();
  const mark = await page.locator('[data-id]').first().boundingBox();
  if (!mark) throw new Error('圈选没有尺寸');
  await page.mouse.click(mark.x + mark.width / 2, mark.y + mark.height / 2);
  await expect(page.locator('[data-transform-handle="se"]')).toBeVisible();
  await expect(page.locator('[data-transform-handle="rotate"]')).toHaveCount(0);

  const clipped = () => page.evaluate(() => {
    const path = document.querySelector<SVGPathElement>('#board [data-id] path');
    const board = document.querySelector<SVGSVGElement>('#board');
    if (!path || !board) return true;
    const bbox = path.getBBox();
    const view = board.viewBox.baseVal;
    return bbox.x < view.x - .5 || bbox.y < view.y - .5 ||
      bbox.x + bbox.width > view.x + view.width + .5 ||
      bbox.y + bbox.height > view.y + view.height + .5;
  });

  await page.keyboard.press('f');
  expect(await clipped()).toBe(false);

  await page.reload();
  await expect(page.locator('main')).not.toHaveAttribute('inert', '');
  await expect(page.locator('[data-id] path')).toHaveCount(1);
  expect(await clipped()).toBe(false);
});

test('window resize keeps the current zoom and view center', async ({page}) => {
  await page.goto('/?renderer=svg');
  await expect(page.locator('main')).not.toHaveAttribute('inert', '');
  await page.locator('.menu summary').click();
  await page.locator('#new').click();
  await page.keyboard.press('0');
  for (let index = 0; index < 4; index++) await page.keyboard.press('+');
  const zoom = await page.locator('#zoom-reset').textContent();
  const before = await viewBox(page);

  await page.setViewportSize({width: 1000, height: 700});
  await page.waitForTimeout(250);
  const after = await viewBox(page);
  expect(await page.locator('#zoom-reset').textContent()).toBe(zoom);
  expect(after[0] + after[2] / 2).toBeCloseTo(before[0] + before[2] / 2, 3);
  expect(after[1] + after[3] / 2).toBeCloseTo(before[1] + before[3] / 2, 3);
});

test('10% zoom keeps line hit targets usable with an 18px screen-space proxy', async ({page}) => {
  await page.goto('/?renderer=svg');
  await expect(page.locator('main')).not.toHaveAttribute('inert', '');
  await page.locator('.menu summary').click();
  await page.locator('#new').click();
  const box = await page.locator('#board').boundingBox();
  if (!box) throw new Error('画板没有尺寸');

  await page.locator('[data-tool="line"]').click();
  await page.mouse.move(box.x + 260, box.y + 250);
  await page.mouse.down();
  await page.mouse.move(box.x + 620, box.y + 250, {steps: 6});
  await page.mouse.up();
  await expect(page.locator('[data-shape-id]')).toHaveCount(1);

  for (let index = 0; index < 30; index++) await page.keyboard.press('-');
  await expect(page.locator('#zoom-reset')).toHaveText('10%');
  const midpoint = await page.locator('[data-shape-id] path').first().evaluate(node => {
    const path = node as SVGPathElement;
    const board = document.querySelector<SVGSVGElement>('#board')!;
    const matrix = board.getScreenCTM()!;
    const point = path.getPointAtLength(path.getTotalLength() / 2);
    const screen = new DOMPoint(point.x, point.y).matrixTransform(matrix);
    return {x: screen.x, y: screen.y};
  });

  await page.locator('[data-tool="select"]').click();
  // 10% 下旧代理只有约 1.8px；点在线上方 6px 仍应选中。
  await page.mouse.click(midpoint.x, midpoint.y - 6);
  await expect(page.locator('#shape-actions')).toBeVisible();
  await expect(page.locator('#shape-count')).toHaveText('已选 1 个图形');
});
