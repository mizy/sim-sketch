import {expect, test} from '@playwright/test';
import type {Page} from '@playwright/test';

async function seedProject(page: Page, project: unknown): Promise<void> {
  await page.goto('/?renderer=svg');
  await expect(page.locator('main')).not.toHaveAttribute('inert', '');
  await page.evaluate(async seed => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('sim-sketch', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('projects');
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction('projects', 'readwrite');
        transaction.objectStore('projects').put(seed, 'draft');
        transaction.oncomplete = () => { db.close(); resolve(); };
        transaction.onerror = () => reject(transaction.error);
      };
      request.onerror = () => reject(request.error);
    });
  }, project);
  await page.reload();
  await expect(page.locator('main')).not.toHaveAttribute('inert', '');
}

test('over-bound draft coordinates are clamped with a notice instead of dropping the object', async ({page}) => {
  await seedProject(page, {
    layers: [{id: 'layer-default', name: '图层 1', opacity: 1}],
    shapes: [{id: 'edge', type: 'rect', layerId: 'layer-default', color: '#2e4f77',
      strokeWidth: 1, a: [999990, -5], b: [1000005, 5]}]
  });

  await expect(page.locator('[data-shape-id]')).toHaveCount(1);
  await expect(page.locator('#notice')).toContainText('超出安全范围');

  // 刷新会再次读取同一份旧草稿；对象仍应保留，而不是第一次加载后被静默删除。
  await page.reload();
  await expect(page.locator('main')).not.toHaveAttribute('inert', '');
  await expect(page.locator('[data-shape-id]')).toHaveCount(1);
  await expect(page.locator('#notice')).toContainText('超出安全范围');
});

test('pasting a dense multi-ring path rebuilds snapping without stack overflow', async ({page}) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/?renderer=svg');
  await expect(page.locator('main')).not.toHaveAttribute('inert', '');

  await page.evaluate(() => {
    // 约 3 万 ring / 9 万顶点，仍低于剪贴板 20 万顶点预算；旧实现会在此展开 15 万 feature。
    const polygons = Array.from({length: 30_000}, (_, index) => [[
      [index, 0], [index + 0.5, 0], [index, 0.5]
    ]]);
    const text = JSON.stringify({
      format: 'sim-sketch/clipboard', version: 1,
      shapes: [{id: 'dense', type: 'path', layerId: 'layer-default', color: '#2e4f77',
        strokeWidth: 1, polygons}], marks: []
    });
    const data = new DataTransfer();
    data.setData('text/plain', text);
    const event = new Event('paste', {bubbles: true, cancelable: true});
    Object.defineProperty(event, 'clipboardData', {value: data});
    document.dispatchEvent(event);
  });

  await expect(page.locator('[data-shape-id]')).toHaveCount(1);
  await expect(page.locator('#status')).toHaveText('草稿已保存在此设备');
  // 页面仍可继续交互，而不是 apply 中断后停在半损坏状态。
  await page.keyboard.press('0');
  await expect(page.locator('#zoom-reset')).toContainText('100%');
  expect(errors).toEqual([]);
});

test('a legal far-coordinate draft is visible and draggable after reload', async ({page}) => {
  await seedProject(page, {
    layers: [{id: 'layer-default', name: '图层 1', opacity: 1}],
    shapes: [{id: 'far', type: 'rect', layerId: 'layer-default', color: '#2e4f77',
      strokeWidth: 1, a: [999990, -20], b: [1000000, 20]}]
  });

  const board = await page.locator('#board').boundingBox();
  const shape = page.locator('[data-shape-id]').first();
  const before = await shape.boundingBox();
  if (!board || !before) throw new Error('远坐标图形没有可见包围盒');

  // 加载后必须框住内容，而不是把 960×600 基准并入后夹到 10% 导致全空白。
  expect(before.x).toBeGreaterThanOrEqual(board.x);
  expect(before.y).toBeGreaterThanOrEqual(board.y);
  expect(before.x + before.width).toBeLessThanOrEqual(board.x + board.width);
  expect(before.y + before.height).toBeLessThanOrEqual(board.y + board.height);

  // 刷新默认工具是画笔；先切到选择，确保拖动走对象移动而不是新建笔迹。
  await page.locator('button[data-tool="select"]').click();
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
  await page.mouse.down();
  await expect(page.locator('#shape-actions')).toBeVisible();
  await page.mouse.move(before.x + before.width / 2 + 120, before.y + before.height / 2 + 60, {steps: 8});
  await page.mouse.up();
  const after = await shape.boundingBox();
  if (!after) throw new Error('拖动后图形消失');
  expect(after.x).toBeGreaterThan(before.x + 20);
  expect(after.y).toBeGreaterThan(before.y + 20);
});

test('dragging past the world boundary keeps the object recoverable after reload', async ({page}) => {
  await seedProject(page, {
    layers: [{id: 'layer-default', name: '图层 1', opacity: 1}],
    shapes: [{id: 'edge', type: 'rect', layerId: 'layer-default', color: '#2e4f77',
      strokeWidth: 1, a: [999990, -20], b: [1000000, 20]}]
  });

  const shape = page.locator('[data-shape-id]').first();
  await expect(shape).toHaveCount(1);
  const box = await shape.boundingBox();
  if (!box) throw new Error('图形没有可交互包围盒');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 320, box.y + box.height / 2, {steps: 8});
  await page.mouse.up();

  await expect(page.locator('[data-shape-id]')).toHaveCount(1);
  await page.reload();
  await expect(page.locator('main')).not.toHaveAttribute('inert', '');
  await expect(page.locator('[data-shape-id]')).toHaveCount(1);
});
