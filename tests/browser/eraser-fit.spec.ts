import {readFileSync} from 'node:fs';
import {expect, test} from '@playwright/test';
import type {Page} from '@playwright/test';

async function openEmpty(page: Page): Promise<void> {
  await page.goto('/?renderer=svg');
  await expect(page.locator('main')).not.toHaveAttribute('inert', '');
  await expect(page.locator('#board')).toHaveAttribute('data-renderer', 'svg');
  await page.locator('.menu summary').click();
  await page.locator('#new').click();
  await page.keyboard.press('0');
}

async function drawPen(page: Page, y: number): Promise<void> {
  await page.locator('button[data-tool="pen"]').click();
  const box = await page.locator('#board').boundingBox();
  if (!box) throw new Error('画板没有尺寸');
  await page.mouse.move(box.x + box.width / 2 - 80, box.y + y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + y, {steps: 6});
  await page.mouse.up();
  await page.keyboard.press('Escape');
}

async function exportSvg(page: Page): Promise<string> {
  await page.locator('.menu summary').click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#export-svg').click()
  ]);
  return readFileSync(await download.path(), 'utf8');
}

async function exportJson(page: Page): Promise<{
  marks: Array<{shape: string; curve?: {segments: Array<{type: string}>}; points?: Array<[number, number]>}>
}> {
  await page.locator('.menu summary').click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#export-json').click()
  ]);
  return JSON.parse(readFileSync(await download.path(), 'utf8'));
}

test('eraser hits whole strokes, supports one-drag undo and never writes empty history', async ({page}) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await openEmpty(page);
  await drawPen(page, 200);
  await drawPen(page, 320);
  await expect(page.locator('[data-id]')).toHaveCount(2);

  await page.keyboard.press('e');
  await expect(page.locator('button[data-tool="eraser"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#eraser-size')).toBeVisible();
  await expect(page.locator('#hint')).toContainText('擦除');

  const box = await page.locator('#board').boundingBox();
  if (!box) throw new Error('画板没有尺寸');
  const x = box.x + box.width / 2;
  // 一次竖向拖动穿过两条笔迹：两条都删除，但只产生一步历史。
  await page.mouse.move(x, box.y + 160);
  await page.mouse.down();
  await page.mouse.move(x, box.y + 360, {steps: 10});
  await page.mouse.up();
  await expect(page.locator('[data-id]')).toHaveCount(0);

  await page.keyboard.press('Control+z');
  await expect(page.locator('[data-id]')).toHaveCount(2);

  // 空白处拖动不提交；随后一次撤销必须回退到上一条真实绘制（只剩 1 条）。
  await page.mouse.move(box.x + 120, box.y + 80);
  await page.mouse.down();
  await page.mouse.move(box.x + 200, box.y + 80, {steps: 4});
  await page.mouse.up();
  await expect(page.locator('[data-id]')).toHaveCount(2);
  await page.keyboard.press('Control+z');
  await expect(page.locator('[data-id]')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('line fitting persists, export keeps the bezier path and curve kind survives reload', async ({page}) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await openEmpty(page);

  await page.selectOption('#pen-fit', 'line');
  await expect(page.locator('#pen-curve')).toBeHidden();
  await page.selectOption('#pen-fit', 'curve');
  await page.selectOption('#pen-curve', 'cubic');
  await expect(page.locator('#pen-curve')).toBeVisible();
  await page.selectOption('#pen-fit', 'line');

  await drawPen(page, 240);
  await expect(page.locator('[data-id]')).toHaveCount(1);
  let exported = await exportJson(page);
  let pen = exported.marks.find(mark => mark.shape === 'pen');
  expect(pen?.curve?.segments[0]?.type).toBe('line');
  // 直线拟合后离散点退化为固定的首尾两点。
  expect(pen?.points).toHaveLength(2);

  await page.reload();
  await expect(page.locator('main')).not.toHaveAttribute('inert', '');
  await expect(page.locator('#pen-fit')).toHaveValue('line');
  await expect(page.locator('#pen-curve')).toBeHidden();
  await expect(page.locator('[data-id]')).toHaveCount(1);
  exported = await exportJson(page);
  pen = exported.marks.find(mark => mark.shape === 'pen');
  expect(pen?.curve?.segments[0]?.type).toBe('line');

  // 曲线模式：拟合结果必须进入 SVG 导出的 Q/C 命令，而不只是 JSON 字段。
  await page.selectOption('#pen-fit', 'curve');
  await page.selectOption('#pen-curve', 'cubic');
  // 刷新后视口只框内容，先回到 100% 让下面的固定像素轨迹保持世界尺度可比。
  await page.keyboard.press('0');
  const box = await page.locator('#board').boundingBox();
  if (!box) throw new Error('画板没有尺寸');
  const cx = box.x + box.width / 2;
  await page.locator('button[data-tool="pen"]').click();
  await page.mouse.move(cx - 80, box.y + 420);
  await page.mouse.down();
  // 连续弧线采样，确保 RDP 后仍有足够内部点约束三次贝塞尔。
  for (let index = 1; index <= 24; index++) {
    const t = index / 24;
    await page.mouse.move(cx - 80 + 160 * t, box.y + 420 + 36 * Math.sin(Math.PI * t));
  }
  await page.mouse.up();
  await page.keyboard.press('Escape');
  exported = await exportJson(page);
  const curves = exported.marks.filter(mark => mark.shape === 'pen' && mark.curve);
  expect(curves.some(mark => mark.curve?.segments[0]?.type === 'cubic')).toBe(true);
  const svg = await exportSvg(page);
  expect(svg).toMatch(/[QC]-?\d/);
  expect(svg).toContain('stroke-linecap="round"');
  expect(errors).toEqual([]);
});
