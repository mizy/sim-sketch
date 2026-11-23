import {readFileSync} from 'node:fs';
import {expect, test} from '@playwright/test';
import type {Page} from '@playwright/test';

interface ExportJson {
  viewBox: number[];
  marks: Array<{shape: string; points?: Array<[number, number]>}>;
  shapes: unknown[];
}

async function exportJson(page: Page): Promise<ExportJson> {
  await page.locator('.menu summary').click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#export-json').click()
  ]);
  return JSON.parse(readFileSync(await download.path(), 'utf8')) as ExportJson;
}

async function exportSvg(page: Page): Promise<string> {
  await page.locator('.menu summary').click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#export-svg').click()
  ]);
  return readFileSync(await download.path(), 'utf8');
}

async function viewBox(page: Page): Promise<number[]> {
  const value = await page.locator('#board').getAttribute('viewBox');
  if (!value) throw new Error('画板没有 viewBox');
  return value.split(/\s+/).map(Number);
}

/** 内容在负坐标/远处时，F、选中、导出与背景都必须仍围绕内容工作。 */
test('panning beyond the origin, drawing, F and export stay content-relative', async ({page}) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/?renderer=svg');
  await expect(page.locator('main')).not.toHaveAttribute('inert', '');
  await expect(page.locator('#board')).toHaveAttribute('data-renderer', 'svg');
  await page.locator('.menu summary').click();
  await page.locator('#new').click();
  await page.keyboard.press('0');

  const box = await page.locator('#board').boundingBox();
  if (!box) throw new Error('画板没有尺寸');
  const center = {x: box.x + box.width / 2, y: box.y + box.height / 2};

  // 中键拖拽把视口平移到世界坐标约 -5500；整个过程不产生对象、不影响缩放。
  for (let index = 0; index < 11; index++) {
    await page.mouse.move(center.x - 250, center.y);
    await page.mouse.down({button: 'middle'});
    await page.mouse.move(center.x + 250, center.y, {steps: 4});
    await page.mouse.up({button: 'middle'});
  }
  await expect(page.locator('#zoom-reset')).toHaveText('100%');
  const panned = await viewBox(page);
  expect(panned[0]).toBeLessThan(-4000);
  await expect(page.locator('[data-id]')).toHaveCount(0);

  // 在负坐标处画一笔；结束拖动后应保留为可命中、可变换的标注。
  await page.locator('button[data-tool="pen"]').click();
  await page.selectOption('#pen-fit', 'off');
  await page.mouse.move(center.x - 45, center.y);
  await page.mouse.down();
  await page.mouse.move(center.x, center.y + 24, {steps: 6});
  await page.mouse.move(center.x + 45, center.y, {steps: 6});
  await page.mouse.up();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-id]')).toHaveCount(1);

  const exportedBeforeFit = await exportJson(page);
  const pen = exportedBeforeFit.marks.find(mark => mark.shape === 'pen');
  if (!pen?.points?.length) throw new Error('导出的画笔点缺失');
  expect(pen.points.every(([x, y]) => x < -4000 && Math.abs(y) < 500)).toBe(true);

  // 负坐标内容仍可点选，并显示变换手柄。
  await page.locator('button[data-tool="select"]').click();
  await page.mouse.click(center.x, center.y + 24);
  await expect(page.locator('#selection-actions')).toBeVisible();
  await expect(page.locator('[data-transform-handle="se"]')).toBeVisible();

  // F 只框内容：viewBox 明显小于基准 960，且中心贴近笔迹而不是原点。
  await page.keyboard.press('f');
  const fitted = await viewBox(page);
  expect(fitted[2]).toBeLessThan(960);
  const xs = pen.points.map(point => point[0]);
  const ys = pen.points.map(point => point[1]);
  const contentCenterX = (Math.min(...xs) + Math.max(...xs)) / 2;
  const contentCenterY = (Math.min(...ys) + Math.max(...ys)) / 2;
  expect(fitted[0] + fitted[2] / 2).toBeCloseTo(contentCenterX, 0);
  expect(fitted[1] + fitted[3] / 2).toBeCloseTo(contentCenterY, 0);
  for (const [x, y] of pen.points) {
    expect(x).toBeGreaterThanOrEqual(fitted[0]);
    expect(y).toBeGreaterThanOrEqual(fitted[1]);
    expect(x).toBeLessThanOrEqual(fitted[0] + fitted[2]);
    expect(y).toBeLessThanOrEqual(fitted[1] + fitted[3]);
  }

  // SVG 回退的底色/网格随 viewBox 铺满，不再是固定 20000 世界单位窗口。
  const backdrop = await page.locator('#board [data-render-geometry] > rect').first().evaluate(node => {
    const element = node as SVGRectElement;
    return {x: Number(element.getAttribute('x')), y: Number(element.getAttribute('y')),
      width: Number(element.getAttribute('width')), height: Number(element.getAttribute('height'))};
  });
  expect(backdrop.x).toBeCloseTo(fitted[0], 3);
  expect(backdrop.y).toBeCloseTo(fitted[1], 3);
  expect(backdrop.width).toBeCloseTo(fitted[2], 3);
  expect(backdrop.height).toBeCloseTo(fitted[3], 3);

  // JSON/SVG 导出都按内容包围盒，且与当前平移无关。
  const exported = await exportJson(page);
  expect(exported.viewBox[0]).toBeGreaterThan(-6000);
  expect(exported.viewBox[1]).toBeGreaterThan(-6000);
  // 导出保持 960×600 的内容适配比例，可不同于实时窗口比例，但必须包含同一内容。
  expect(exported.viewBox[2] / exported.viewBox[3]).toBeCloseTo(960 / 600, 6);
  expect(exported.viewBox[0] + exported.viewBox[2] / 2).toBeCloseTo(contentCenterX, 0);
  expect(exported.viewBox[1] + exported.viewBox[3] / 2).toBeCloseTo(contentCenterY, 0);
  for (const [x, y] of pen.points) {
    expect(x).toBeGreaterThanOrEqual(exported.viewBox[0]);
    expect(y).toBeGreaterThanOrEqual(exported.viewBox[1]);
    expect(x).toBeLessThanOrEqual(exported.viewBox[0] + exported.viewBox[2]);
    expect(y).toBeLessThanOrEqual(exported.viewBox[1] + exported.viewBox[3]);
  }

  const svg = await exportSvg(page);
  const svgViewBox = svg.match(/viewBox="([^"]+)"/)?.[1]?.split(/\s+/).map(Number);
  expect(svgViewBox).toBeDefined();
  expect(svgViewBox![0]).toBeCloseTo(exported.viewBox[0], 3);
  expect(svgViewBox![1]).toBeCloseTo(exported.viewBox[1], 3);
  expect(svgViewBox![2]).toBeCloseTo(exported.viewBox[2], 3);
  expect(svgViewBox![3]).toBeCloseTo(exported.viewBox[3], 3);
  expect(svg).toContain('stroke-linecap="round"');
  expect(errors).toEqual([]);
});
