import {readFileSync} from 'node:fs';
import {expect, test} from '@playwright/test';
import type {Download, Page} from '@playwright/test';

async function openEmptySketch(page: Page): Promise<void> {
  await page.goto('/?renderer=svg');
  await expect(page.locator('main')).not.toHaveAttribute('inert', '');
  await expect(page.locator('#board')).toHaveAttribute('data-renderer', 'svg');
  await page.locator('.menu summary').click();
  await page.locator('#new').click();
  await expect(page.locator('#status')).toHaveText('草稿已保存在此设备');
}

async function drawRect(page: Page, x: number, y: number): Promise<void> {
  await page.locator('button[data-tool="rect"]').click();
  const box = await page.locator('#board').boundingBox();
  if (!box) throw new Error('画板没有尺寸');
  await page.mouse.move(box.x + x, box.y + y);
  await page.mouse.down();
  await page.mouse.move(box.x + x + 130, box.y + y + 90, {steps: 6});
  await page.mouse.up();
  await expect(page.locator('#status')).toHaveText('草稿已保存在此设备');
}

async function selectFirstRect(page: Page): Promise<void> {
  await page.locator('button[data-tool="select"]').click();
  const node = page.locator('[data-shape-id]').first();
  const box = await node.boundingBox();
  if (!box) throw new Error('矩形没有尺寸');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator('#shape-actions')).toBeVisible();
  await expect(page.locator('[data-transform-handle="se"]')).toBeVisible();
}

async function downloadFromMenu(page: Page, button: string): Promise<Download> {
  await page.locator('.menu summary').click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator(button).click()
  ]);
  return download;
}

async function dragHandle(page: Page, handle: string, dx: number, dy: number): Promise<void> {
  const box = await page.locator(`[data-transform-handle="${handle}"]`).boundingBox();
  if (!box) throw new Error(`手柄 ${handle} 没有尺寸`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, {steps: 8});
  await page.mouse.up();
  await expect(page.locator('#status')).toHaveText('草稿已保存在此设备');
}

test('rectangle exposes 8 local-axis handles with >=24px hit areas', async ({page}) => {
  await openEmptySketch(page);
  await drawRect(page, 220, 160);
  await selectFirstRect(page);
  for (const handle of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w', 'rotate']) {
    await expect(page.locator(`[data-transform-handle="${handle}"]`)).toBeVisible();
  }
  for (const handle of ['n', 'e', 's', 'w']) {
    const box = await page.locator(`[data-transform-handle="${handle}"]`).boundingBox();
    if (!box) throw new Error(`${handle} 手柄没有命中区`);
    expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(24);
  }
});

test('small rect scales from its real pivot and never shrinks below 4x4', async ({page}) => {
  await openEmptySketch(page);
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('sim-sketch', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('projects');
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction('projects', 'readwrite');
        transaction.objectStore('projects').put({
          layers: [{id: 'layer-default', name: '图层 1', opacity: 1}],
          shapes: [{id: 'small', type: 'rect', layerId: 'layer-default', color: '#2e4f77',
            strokeWidth: 2.4, a: [470, 295], b: [480, 299]}]
        }, 'draft');
        transaction.oncomplete = () => { db.close(); resolve(); };
        transaction.onerror = () => reject(transaction.error);
      };
      request.onerror = () => reject(request.error);
    });
  });
  await page.reload();
  await expect(page.locator('[data-shape-id]')).toHaveCount(1);

  // 放大到 8×，让 10×4 小矩形的 24px 命中圈彼此分离，避免点到相邻手柄。
  for (let index = 0; index < 12; index++) await page.keyboard.press('+');
  await page.locator('button[data-tool="select"]').click();
  const shape = page.locator('[data-shape-id]').first();
  const bounds = await shape.boundingBox();
  if (!bounds) throw new Error('小矩形没有尺寸');
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await expect(page.locator('[data-transform-handle="se"]')).toBeVisible();
  await expect(page.locator('[data-transform-handle="nw"]')).toBeVisible();

  // 从外扩后的 se 手柄拖到真实 nw 角：按下瞬间不能跳变，收缩夹到 4×4。
  const se = await page.locator('[data-transform-handle="se"]').boundingBox();
  const nw = await page.locator('[data-transform-handle="nw"]').boundingBox();
  if (!se || !nw) throw new Error('缩放手柄没有命中区');
  await page.mouse.move(se.x + se.width / 2, se.y + se.height / 2);
  await page.mouse.down();
  await page.mouse.move(nw.x + nw.width / 2, nw.y + nw.height / 2, {steps: 8});
  await page.mouse.up();
  await expect(page.locator('#status')).toHaveText('草稿已保存在此设备');

  const download = await downloadFromMenu(page, '#export-json');
  const path = await download.path();
  if (!path) throw new Error('JSON 下载路径不可用');
  const exported = JSON.parse(readFileSync(path, 'utf8')) as {shapes: {a: [number, number]; b: [number, number]}[]};
  const [next] = exported.shapes;
  expect(next.a[0]).toBeCloseTo(470, 3);
  expect(next.a[1]).toBeCloseTo(295, 3);
  expect(next.b[0] - next.a[0]).toBeCloseTo(4, 3);
  expect(next.b[1] - next.a[1]).toBeCloseTo(4, 3);
});

test('corner handles scale a rectangle with one undo entry', async ({page}) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await openEmptySketch(page);
  await drawRect(page, 220, 160);
  await selectFirstRect(page);

  const before = await page.locator('[data-shape-id] path').first().getAttribute('d');
  await dragHandle(page, 'se', 70, 50);
  const scaled = await page.locator('[data-shape-id] path').first().getAttribute('d');
  expect(scaled).not.toBe(before);

  // 一次变换只产生一条 undo：第一次回到缩放前，第二次才撤销矩形创建。
  await page.keyboard.press('Control+z');
  await expect(page.locator('[data-shape-id] path').first()).toHaveAttribute('d', before!);
  await page.keyboard.press('Control+z');
  await expect(page.locator('[data-shape-id]')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('free rotation is not forced to 15 degrees; Shift snaps; Escape cancels', async ({page}) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await openEmptySketch(page);
  await drawRect(page, 260, 180);
  await selectFirstRect(page);
  const before = await page.locator('[data-shape-id] path').first().getAttribute('d');
  expect(before).toContain('H');

  const bounds = await page.locator('[data-shape-id]').first().boundingBox();
  if (!bounds) throw new Error('矩形没有尺寸');
  const center = {x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2};
  const rotate = await page.locator('[data-transform-handle="rotate"]').boundingBox();
  if (!rotate) throw new Error('旋转手柄没有尺寸');
  await page.mouse.move(rotate.x + rotate.width / 2, rotate.y + rotate.height / 2);
  await page.mouse.down();
  await page.mouse.move(center.x + 120, center.y + 20, {steps: 8});
  await page.mouse.up();
  await expect(page.locator('#status')).toHaveText('草稿已保存在此设备');

  const rotated = await page.locator('[data-shape-id] path').first().getAttribute('d');
  expect(rotated).not.toBe(before);
  expect(rotated).toContain('L');
  expect(rotated).not.toContain('H');

  const firstJson = await downloadFromMenu(page, '#export-json');
  const firstPath = await firstJson.path();
  if (!firstPath) throw new Error('JSON 下载路径不可用');
  const first = JSON.parse(readFileSync(firstPath, 'utf8')) as {shapes: {type: string; rotation?: number}[]};
  expect(first.shapes[0].type).toBe('rect');
  const freeAngle = first.shapes[0].rotation ?? 0;
  expect(Math.abs(freeAngle)).toBeGreaterThan(1);
  // 自由旋转落点不在 15° 整数倍上。
  expect(Math.abs(freeAngle / 15 - Math.round(freeAngle / 15))).toBeGreaterThan(0.05);

  await page.keyboard.press('Control+z');
  await expect(page.locator('[data-shape-id] path').first()).toHaveAttribute('d', before!);

  // 按住 Shift 才吸附到 15°。
  await selectFirstRect(page);
  const rotateAgain = await page.locator('[data-transform-handle="rotate"]').boundingBox();
  if (!rotateAgain) throw new Error('旋转手柄没有尺寸');
  await page.mouse.move(rotateAgain.x + rotateAgain.width / 2, rotateAgain.y + rotateAgain.height / 2);
  await page.mouse.down();
  await page.keyboard.down('Shift');
  await page.mouse.move(center.x + 120, center.y + 20, {steps: 8});
  await page.mouse.up();
  await page.keyboard.up('Shift');
  const snappedJson = await downloadFromMenu(page, '#export-json');
  const snappedPath = await snappedJson.path();
  if (!snappedPath) throw new Error('JSON 下载路径不可用');
  const snapped = JSON.parse(readFileSync(snappedPath, 'utf8')) as {shapes: {rotation?: number}[]};
  const snappedAngle = snapped.shapes[0].rotation ?? 0;
  expect(Math.abs(snappedAngle / 15 - Math.round(snappedAngle / 15))).toBeLessThan(0.01);

  await page.keyboard.press('Control+z');
  await expect(page.locator('[data-shape-id] path').first()).toHaveAttribute('d', before!);

  // 再次拖动后按 Esc：预览丢弃，路径保持原样，也不写 undo。
  await selectFirstRect(page);
  const se = await page.locator('[data-transform-handle="se"]').boundingBox();
  if (!se) throw new Error('缩放手柄没有尺寸');
  await page.mouse.move(se.x + se.width / 2, se.y + se.height / 2);
  await page.mouse.down();
  await page.mouse.move(se.x + 60, se.y + 40, {steps: 6});
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(page.locator('[data-shape-id] path').first()).toHaveAttribute('d', before!);
  expect(errors).toEqual([]);
});

test('Shift rotation snaps an already free-rotated object to the absolute 15° grid', async ({page}) => {
  await openEmptySketch(page);
  await drawRect(page, 260, 180);
  await selectFirstRect(page);

  // 先自由旋转到非 15° 整数倍（约 99°）。
  await dragHandle(page, 'rotate', 120, 20);
  const first = await downloadFromMenu(page, '#export-json');
  const firstPath = await first.path();
  if (!firstPath) throw new Error('JSON 下载路径不可用');
  const freeRotation = (JSON.parse(readFileSync(firstPath, 'utf8')) as {
    shapes: {rotation?: number}[]}).shapes[0].rotation ?? 0;
  expect(Math.abs(freeRotation / 15 - Math.round(freeRotation / 15))).toBeGreaterThan(0.05);

  // 第二次旋转按住 Shift：必须吸附绝对角（15° 网格），不能是“99° + 15k”。
  const rotate = await page.locator('[data-transform-handle="rotate"]').boundingBox();
  if (!rotate) throw new Error('旋转手柄没有尺寸');
  await page.mouse.move(rotate.x + rotate.width / 2, rotate.y + rotate.height / 2);
  await page.mouse.down();
  await page.keyboard.down('Shift');
  await page.mouse.move(rotate.x + rotate.width / 2 + 80, rotate.y + rotate.height / 2 + 40, {steps: 8});
  await page.mouse.up();
  await page.keyboard.up('Shift');

  const second = await downloadFromMenu(page, '#export-json');
  const secondPath = await second.path();
  if (!secondPath) throw new Error('JSON 下载路径不可用');
  const snapped = (JSON.parse(readFileSync(secondPath, 'utf8')) as {
    shapes: {rotation?: number}[]}).shapes[0].rotation ?? 0;
  expect(Math.abs(snapped / 15 - Math.round(snapped / 15))).toBeLessThan(0.01);
});

test('local-axis scaling a rotated rectangle keeps rect identity and rotation', async ({page}) => {
  await openEmptySketch(page);
  await drawRect(page, 260, 180);
  await selectFirstRect(page);
  const bounds = await page.locator('[data-shape-id]').first().boundingBox();
  if (!bounds) throw new Error('矩形没有尺寸');
  const center = {x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2};
  const rotate = await page.locator('[data-transform-handle="rotate"]').boundingBox();
  if (!rotate) throw new Error('旋转手柄没有尺寸');
  await page.mouse.move(rotate.x + rotate.width / 2, rotate.y + rotate.height / 2);
  await page.mouse.down();
  await page.mouse.move(center.x + 140, center.y, {steps: 8});
  await page.mouse.up();
  await expect(page.locator('#status')).toHaveText('草稿已保存在此设备');
  expect(await page.locator('[data-shape-id] path').first().getAttribute('d')).toContain('L');

  await dragHandle(page, 'se', 90, 20);
  const jsonDownload = await downloadFromMenu(page, '#export-json');
  const jsonPath = await jsonDownload.path();
  if (!jsonPath) throw new Error('JSON 下载路径不可用');
  const exported = JSON.parse(readFileSync(jsonPath, 'utf8')) as {shapes: {type: string; rotation?: number}[]};
  expect(exported.shapes).toHaveLength(1);
  expect(exported.shapes[0].type).toBe('rect');
  expect(exported.shapes[0].rotation).toBeDefined();
  expect(Math.abs(exported.shapes[0].rotation ?? 0)).toBeGreaterThan(1);

  await page.reload();
  await expect(page.locator('main')).not.toHaveAttribute('inert', '');
  await expect(page.locator('[data-shape-id]')).toHaveCount(1);
  expect(await page.locator('[data-shape-id] path').first().getAttribute('d')).toContain('L');
});

test('Shift scaling keeps the rectangle aspect ratio', async ({page}) => {
  await openEmptySketch(page);
  await drawRect(page, 220, 160);
  await selectFirstRect(page);
  const geometry = () => page.locator('[data-shape-id] path').first()
    .evaluate(node => {
      const box = (node as SVGGraphicsElement).getBBox();
      return {width: box.width, height: box.height};
    });
  const before = await geometry();

  const se = await page.locator('[data-transform-handle="se"]').boundingBox();
  if (!se) throw new Error('缩放手柄没有尺寸');
  const x = se.x + se.width / 2;
  const y = se.y + se.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.keyboard.down('Shift');
  await page.mouse.move(x + 100, y + 15, {steps: 8});
  await page.mouse.up();
  await page.keyboard.up('Shift');

  const after = await geometry();
  expect(after.width / after.height).toBeCloseTo(before.width / before.height, 1);
});

test('annotation rotation shows the live angle readout in the mark action bar', async ({page}) => {
  await openEmptySketch(page);
  const box = await page.locator('#board').boundingBox();
  if (!box) throw new Error('画板没有尺寸');
  await page.locator('[data-tool="arrow"]').click();
  await page.mouse.move(box.x + 260, box.y + 220);
  await page.mouse.down();
  await page.mouse.move(box.x + 380, box.y + 260, {steps: 6});
  await page.mouse.up();
  await expect(page.locator('#status')).toHaveText('草稿已保存在此设备');

  await page.locator('button[data-tool="select"]').click();
  const mark = page.locator('[data-id]').first();
  const bounds = await mark.boundingBox();
  if (!bounds) throw new Error('箭头没有尺寸');
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await expect(page.locator('#selection-actions')).toBeVisible();

  const rotate = await page.locator('[data-transform-handle="rotate"]').boundingBox();
  if (!rotate) throw new Error('标注旋转手柄没有尺寸');
  await page.mouse.move(rotate.x + rotate.width / 2, rotate.y + rotate.height / 2);
  await page.mouse.down();
  await page.mouse.move(rotate.x + rotate.width / 2 + 50, rotate.y + rotate.height / 2 + 20, {steps: 6});
  // 标注没有 #shape-actions，角度必须显示在 #selection-actions 内。
  await expect(page.locator('#selection-angle')).toBeVisible();
  await expect(page.locator('#selection-angle')).not.toHaveText('0°');
  await page.mouse.up();
  await expect(page.locator('#status')).toHaveText('草稿已保存在此设备');
});

test('text marks have no scale/rotate handles but stay draggable and editable', async ({page}) => {
  await openEmptySketch(page);
  const box = await page.locator('#board').boundingBox();
  if (!box) throw new Error('画板没有尺寸');
  await page.locator('[data-tool="text"]').click();
  await page.mouse.click(box.x + 300, box.y + 220);
  await expect(page.locator('#canvas-text')).toBeVisible();
  await page.locator('#canvas-text').fill('编辑测试');
  await page.locator('#canvas-text').press('Enter');
  await expect(page.locator('#status')).toHaveText('草稿已保存在此设备');

  await page.locator('[data-tool="select"]').click();
  const mark = page.locator('[data-id]').first();
  const first = await mark.boundingBox();
  if (!first) throw new Error('文字标注没有尺寸');
  await page.mouse.click(first.x + first.width / 2, first.y + first.height / 2);
  await expect(page.locator('#selection-actions')).toBeVisible();
  await expect(page.locator('[data-transform-handle]')).toHaveCount(0);

  // 拖动文字本体只移动锚点，不出现“拖动放大后回弹”的误导手势。
  await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(first.x + first.width / 2 + 40, first.y + first.height / 2 + 30, {steps: 6});
  await page.mouse.up();
  await expect(page.locator('#status')).toHaveText('草稿已保存在此设备');

  const moved = await mark.boundingBox();
  if (!moved) throw new Error('移动后的文字标注没有尺寸');
  expect(moved.x).toBeGreaterThan(first.x);
  expect(moved.y).toBeGreaterThan(first.y);
  await page.mouse.dblclick(moved.x + moved.width / 2, moved.y + moved.height / 2);
  await expect(page.locator('#canvas-text')).toBeVisible();
  await expect(page.locator('#canvas-text')).toHaveValue('编辑测试');
});

test('circle scaling is forced uniform so it never becomes an ellipse', async ({page}) => {
  await openEmptySketch(page);
  await page.locator('button[data-tool="circle"]').click();
  const box = await page.locator('#board').boundingBox();
  if (!box) throw new Error('画板没有尺寸');
  await page.mouse.move(box.x + 360, box.y + 260);
  await page.mouse.down();
  await page.mouse.move(box.x + 430, box.y + 330, {steps: 6});
  await page.mouse.up();
  await expect(page.locator('#status')).toHaveText('草稿已保存在此设备');

  await page.locator('button[data-tool="select"]').click();
  const shape = await page.locator('[data-shape-id]').first().boundingBox();
  if (!shape) throw new Error('圆没有尺寸');
  await page.mouse.click(shape.x + shape.width / 2, shape.y + shape.height / 2);
  await expect(page.locator('[data-transform-handle="se"]')).toBeVisible();
  // 圆没有旋转手柄，且只提供四角等比手柄。
  await expect(page.locator('[data-transform-handle="rotate"]')).toHaveCount(0);
  await expect(page.locator('[data-transform-handle="n"], [data-transform-handle="e"], [data-transform-handle="s"], [data-transform-handle="w"]')).toHaveCount(0);

  // 横向多、纵向少：如果偷偷非等比缩放，圆会变成椭圆。
  await dragHandle(page, 'se', 90, 8);
  const d = await page.locator('[data-shape-id] path').first().getAttribute('d');
  const radii = d?.match(/A([\d.-]+) ([\d.-]+)/);
  expect(radii).not.toBeNull();
  expect(Number(radii![1])).toBeCloseTo(Number(radii![2]), 3);
  await expect(page.locator('#notice')).toContainText('仅支持等比缩放');
});

test('region mark scales through the same handles and undo entry', async ({page}) => {
  await openEmptySketch(page);
  await page.locator('button[data-tool="region"]').click();
  const box = await page.locator('#board').boundingBox();
  if (!box) throw new Error('画板没有尺寸');
  await page.mouse.move(box.x + 220, box.y + 180);
  await page.mouse.down();
  await page.mouse.move(box.x + 360, box.y + 290, {steps: 6});
  await page.mouse.up();
  await expect(page.locator('#status')).toHaveText('草稿已保存在此设备');

  await page.locator('button[data-tool="select"]').click();
  const mark = await page.locator('[data-id]').first().boundingBox();
  if (!mark) throw new Error('圈选没有尺寸');
  await page.mouse.click(mark.x + mark.width / 2, mark.y + mark.height / 2);
  await expect(page.locator('#selection-actions')).toBeVisible();
  await expect(page.locator('[data-transform-handle="se"]')).toBeVisible();
  const before = await page.locator('[data-id] ellipse').first().getAttribute('rx');

  await dragHandle(page, 'se', 50, 30);
  const after = await page.locator('[data-id] ellipse').first().getAttribute('rx');
  expect(Number(after)).toBeGreaterThan(Number(before));

  await page.keyboard.press('Control+z');
  await expect(page.locator('[data-id] ellipse').first()).toHaveAttribute('rx', before!);
});

test('Delete removes the selected annotation and one undo restores it', async ({page}) => {
  await openEmptySketch(page);
  await page.locator('button[data-tool="region"]').click();
  const box = await page.locator('#board').boundingBox();
  if (!box) throw new Error('画板没有尺寸');
  await page.mouse.move(box.x + 240, box.y + 180);
  await page.mouse.down();
  await page.mouse.move(box.x + 380, box.y + 290, {steps: 6});
  await page.mouse.up();
  await expect(page.locator('#status')).toHaveText('草稿已保存在此设备');

  await page.locator('button[data-tool="select"]').click();
  const mark = await page.locator('[data-id]').first().boundingBox();
  if (!mark) throw new Error('圈选没有尺寸');
  await page.mouse.click(mark.x + mark.width / 2, mark.y + mark.height / 2);
  await expect(page.locator('#selection-actions')).toBeVisible();
  await page.keyboard.press('Delete');
  await expect(page.locator('[data-id]')).toHaveCount(0);
  await expect(page.locator('#status')).toHaveText('草稿已保存在此设备');
  await page.keyboard.press('Control+z');
  await expect(page.locator('[data-id]')).toHaveCount(1);
});

test('range focus keeps viewport and Delete shortcuts alive', async ({page}) => {
  await openEmptySketch(page);
  await drawRect(page, 220, 160);
  await selectFirstRect(page);

  await page.locator('#brush-width').focus();
  await page.keyboard.press('0');
  await expect(page.locator('#zoom-reset')).toHaveText('100%');
  await page.keyboard.press('Escape');
  await expect(page.locator('#shape-actions')).toBeHidden();

  await selectFirstRect(page);
  await page.locator('#brush-width').focus();
  await page.keyboard.press('Delete');
  await expect(page.locator('[data-shape-id]')).toHaveCount(0);
  await page.keyboard.press('Control+z');
  await expect(page.locator('[data-shape-id]')).toHaveCount(1);
});

test('multi-selection scales together and commits once', async ({page}) => {
  await openEmptySketch(page);
  await drawRect(page, 180, 150);
  await drawRect(page, 420, 150);
  await page.locator('button[data-tool="select"]').click();

  const nodes = page.locator('[data-shape-id]');
  const paths = page.locator('[data-shape-id] path');
  const first = await nodes.nth(0).boundingBox();
  const second = await nodes.nth(1).boundingBox();
  if (!first || !second) throw new Error('矩形没有尺寸');
  await page.mouse.click(first.x + first.width / 2, first.y + first.height / 2);
  await page.keyboard.down('Shift');
  await page.mouse.click(second.x + second.width / 2, second.y + second.height / 2);
  await page.keyboard.up('Shift');
  await expect(page.locator('#shape-count')).toHaveText('已选 2 个图形');
  await expect(page.locator('[data-transform-handle="se"]')).toBeVisible();

  const before = await paths.evaluateAll(items => items.map(item => item.getAttribute('d')));
  await dragHandle(page, 'se', 50, 30);
  const after = await paths.evaluateAll(items => items.map(item => item.getAttribute('d')));
  expect(after).not.toEqual(before);

  await page.keyboard.press('Control+z');
  const restored = await paths.evaluateAll(items => items.map(item => item.getAttribute('d')));
  expect(restored).toEqual(before);
});
