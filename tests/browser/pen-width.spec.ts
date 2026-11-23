import {expect, test} from '@playwright/test';
import type {Page} from '@playwright/test';

async function openEmptySketch(page: Page): Promise<void> {
  await page.goto('/?renderer=svg');
  await expect(page.locator('main')).not.toHaveAttribute('inert', '');
  await expect(page.locator('#board')).toHaveAttribute('data-renderer', 'svg');
  await page.locator('.menu summary').click();
  await page.locator('#new').click();
  await expect(page.locator('#status')).toHaveText('草稿已保存在此设备');
}

async function drawPen(page: Page, y: number): Promise<void> {
  await page.locator('button[data-tool="pen"]').click();
  const box = await page.locator('#board').boundingBox();
  if (!box) throw new Error('画板没有尺寸');
  await page.mouse.move(box.x + 200, box.y + y);
  await page.mouse.down();
  await page.mouse.move(box.x + 420, box.y + y, {steps: 8});
  await page.mouse.up();
  await expect(page.locator('#status')).toHaveText('草稿已保存在此设备');
}

async function drawRect(page: Page): Promise<void> {
  await page.locator('button[data-tool="rect"]').click();
  const box = await page.locator('#board').boundingBox();
  if (!box) throw new Error('画板没有尺寸');
  await page.mouse.move(box.x + 220, box.y + 160);
  await page.mouse.down();
  await page.mouse.move(box.x + 380, box.y + 280, {steps: 6});
  await page.mouse.up();
  await expect(page.locator('#status')).toHaveText('草稿已保存在此设备');
}

/** 可见几何的线宽（SVG 回退模式）；命中代理不在 data-render-geometry 内。 */
async function visibleWidths(page: Page): Promise<number[]> {
  const widths = await page.locator('#board [data-render-geometry] path, #board [data-render-geometry] ellipse')
    .evaluateAll(nodes => nodes
      .filter(node => {
        const stroke = node.getAttribute('stroke');
        return Boolean(stroke && stroke !== 'none' && node.getAttribute('stroke-width'));
      })
      .map(node => Number(node.getAttribute('stroke-width'))));
  return widths.sort((a, b) => a - b);
}

async function dragWidthSlider(page: Page, target: number): Promise<number> {
  const slider = page.locator('#brush-width');
  const box = await slider.boundingBox();
  if (!box) throw new Error('粗细滑块没有尺寸');
  const x = (value: number): number => box.x + box.width * (value - 1) / 23;
  await page.mouse.move(x(4), box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(x(target), box.y + box.height / 2, {steps: 8});
  await page.mouse.up();
  return Number(await slider.inputValue());
}

/** 往 IndexedDB 写入旧版草稿，再重载验证兼容路径。 */
async function seedDraft(page: Page, draft: unknown): Promise<void> {
  await page.goto('/?renderer=svg');
  await expect(page.locator('main')).not.toHaveAttribute('inert', '');
  await expect(page.locator('#status')).toHaveText('草稿已保存在此设备');
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
  }, draft);
  await page.reload();
  await expect(page.locator('main')).not.toHaveAttribute('inert', '');
}

test('dragging the width slider thickens the next stroke and survives reload', async ({page}) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await openEmptySketch(page);

  await drawPen(page, 180);
  await page.keyboard.press('Escape');
  expect(await visibleWidths(page)).toEqual([4]);

  const slider = page.locator('#brush-width');
  const width = await dragWidthSlider(page, 12);
  expect(width).toBeGreaterThanOrEqual(10);
  await expect(slider).toHaveValue(String(width));
  await expect(page.locator('#brush-width-value')).toHaveText(`${width} px`);
  await expect(page.locator('#brush-width-preview')).toHaveAttribute('stroke-width', String(width));

  await drawPen(page, 320);
  // 新笔迹画完处于选中态（宽度 +2）；先取消选择再断言落盘宽度。
  await page.keyboard.press('Escape');
  expect(await visibleWidths(page)).toEqual([4, width].sort((a, b) => a - b));

  await page.reload();
  await expect(page.locator('main')).not.toHaveAttribute('inert', '');
  await expect(page.locator('#board')).toHaveAttribute('data-renderer', 'svg');
  expect(await visibleWidths(page)).toEqual([4, width].sort((a, b) => a - b));
  // 滑块值本身不持久化：刷新后回到默认 4px，只有标注宽度保留。
  await expect(slider).toHaveValue('4');

  // 选中加粗只是渲染修饰：+2 后按 Esc 必须回到该标注自身的宽度。
  await page.locator('button[data-tool="select"]').click();
  // 刷新后视口只框内容（远/近坐标都不套基准画布）；先回到 100% 避免底部调色板盖住笔迹。
  await page.keyboard.press('0');
  const pen = await page.locator('#board [data-id]').last()
    .evaluate(node => node.getBoundingClientRect().toJSON()) as {
      x: number; y: number; width: number; height: number};
  await page.mouse.click(pen.x + pen.width / 2, pen.y + pen.height / 2);
  await expect(page.locator('#selection-actions')).toBeVisible();
  expect(await visibleWidths(page)).toEqual([4, width + 2].sort((a, b) => a - b));
  await page.keyboard.press('Escape');
  expect(await visibleWidths(page)).toEqual([4, width].sort((a, b) => a - b));
  expect(errors).toEqual([]);
});

test('keyboard adjusts the width and old drafts fall back to 4/3/5', async ({page}) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const draft = {
    reference: null,
    layers: [{id: 'layer-default', name: '图层 1', opacity: 1}],
    marks: [
      {id: 'legacy-pen', shape: 'pen', kind: 'note', layerId: 'layer-default', points: [[100, 100], [300, 100]]},
      {id: 'legacy-region', shape: 'region', kind: 'note', layerId: 'layer-default', a: [400, 150], b: [560, 260]},
      {id: 'legacy-arrow', shape: 'arrow', kind: 'note', layerId: 'layer-default', a: [200, 400], b: [420, 400]}
    ],
    shapes: []
  };
  await seedDraft(page, draft);

  // 旧草稿没有 width：画笔 4、圈选 3、箭头 5（箭杆与箭头各一条）。
  expect(await visibleWidths(page)).toEqual([3, 4, 5, 5]);

  const slider = page.locator('#brush-width');
  await slider.focus();
  for (let step = 0; step < 8; step++) await page.keyboard.press('ArrowRight');
  await expect(slider).toHaveValue('12');
  await expect(page.locator('#brush-width-value')).toHaveText('12 px');

  // 改粗细不会追改旧草稿。
  expect(await visibleWidths(page)).toEqual([3, 4, 5, 5]);
  expect(errors).toEqual([]);
});


test('shape stroke width persists and choosing a color keeps the slider value', async ({page}) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await openEmptySketch(page);

  const width = await dragWidthSlider(page, 10);
  await drawRect(page);
  await page.keyboard.press('Escape');
  expect(await visibleWidths(page)).toEqual([width]);

  // 换颜色只改变后续绘制样式，不应重置当前粗细。
  await page.locator('[data-brush="pressure"]').click();
  await expect(page.locator('#brush-width')).toHaveValue(String(width));

  await page.reload();
  await expect(page.locator('main')).not.toHaveAttribute('inert', '');
  expect(await visibleWidths(page)).toEqual([width]);
  await expect(page.locator('#brush-width')).toHaveValue('4');
  expect(errors).toEqual([]);
});

/**
 * 回归：滑块聚焦时不能吞掉既有画布快捷键。
 * Delete 删除选中图形、Ctrl+Z 撤销、Esc 取消选择都必须与未聚焦时一致。
 */
test('focused form controls keep Delete, undo and Escape working', async ({page}) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await openEmptySketch(page);
  await drawRect(page);

  const selectShape = async (): Promise<void> => {
    await page.locator('button[data-tool="select"]').click();
    const shape = page.locator('[data-shape-id]').first();
    const box = await shape.boundingBox();
    if (!box) throw new Error('图形没有包围盒');
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.locator('#shape-actions')).toBeVisible();
  };

  await selectShape();
  // 使用任务前就存在的图层不透明度滑块复现跨操作回归，而不是只测新增控件。
  await page.locator('#toggle-layers').click();
  await page.locator('#layer-opacity').focus();
  await page.keyboard.press('Delete');
  await expect(page.locator('[data-shape-id]')).toHaveCount(0);

  await page.locator('#brush-width').focus();
  await page.keyboard.press('Control+z');
  await expect(page.locator('[data-shape-id]')).toHaveCount(1);

  await selectShape();
  await page.locator('#layer-opacity').focus();
  await page.keyboard.press('Escape');
  await expect(page.locator('#shape-actions')).toBeHidden();
  expect(errors).toEqual([]);
});

test.describe('mobile palette', () => {
  test.use({viewport: {width: 390, height: 844}});

  test('two-row palette keeps the 4-column wells and a usable width slider', async ({page}) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await openEmptySketch(page);

    const palette = await page.locator('.palette-panel').boundingBox();
    if (!palette) throw new Error('调色板没有尺寸');
    expect(palette.x).toBeGreaterThanOrEqual(0);
    expect(palette.x + palette.width).toBeLessThanOrEqual(390.5);
    expect(await page.locator('.palette-panel').evaluate(node => node.scrollWidth - node.clientWidth))
      .toBeLessThanOrEqual(0);

    const columns = await page.locator('.color-wells').evaluate(node =>
      getComputedStyle(node).gridTemplateColumns.split(' ').filter(Boolean).length);
    expect(columns).toBe(4);

    const slider = page.locator('#brush-width');
    const sliderBox = await slider.boundingBox();
    if (!sliderBox) throw new Error('粗细滑块没有尺寸');
    expect(sliderBox.height).toBeGreaterThanOrEqual(40);
    await slider.focus();
    for (let step = 0; step < 3; step++) await page.keyboard.press('ArrowRight');
    await expect(slider).toHaveValue('7');

    await drawPen(page, 300);
    await page.keyboard.press('Escape');
    await page.locator('button[data-tool="select"]').click();
    const box = await page.locator('#board').boundingBox();
    if (!box) throw new Error('画板没有尺寸');
    await page.mouse.click(box.x + 310, box.y + 300);
    await expect(page.locator('#selection-actions')).toBeVisible();
    const actions = await page.locator('#selection-actions').boundingBox();
    if (!actions) throw new Error('选中操作条没有尺寸');
    expect(actions.x).toBeGreaterThanOrEqual(0);
    expect(actions.y).toBeGreaterThanOrEqual(0);
    expect(actions.x + actions.width).toBeLessThanOrEqual(390.5);
    expect(actions.y + actions.height).toBeLessThanOrEqual(844.5);
    await page.keyboard.press('Escape');
    expect(errors).toEqual([]);
  });
});
