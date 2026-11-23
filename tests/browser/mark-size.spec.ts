import {readFileSync} from 'node:fs';
import {expect, test} from '@playwright/test';
import type {Page} from '@playwright/test';

interface ExportMark {
  shape: string;
  width?: number;
  size?: number;
  fontSize?: number;
  label?: string;
}

async function openEmptySketch(page: Page): Promise<void> {
  await page.goto('/?renderer=svg');
  await expect(page.locator('main')).not.toHaveAttribute('inert', '');
  await expect(page.locator('#board')).toHaveAttribute('data-renderer', 'svg');
  await page.locator('.menu summary').click();
  await page.locator('#new').click();
  await expect(page.locator('#status')).toHaveText('草稿已保存在此设备');
}

async function exportJson(page: Page): Promise<{marks: ExportMark[]}> {
  await page.locator('.menu summary').click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#export-json').click()
  ]);
  return JSON.parse(readFileSync(await download.path(), 'utf8')) as {marks: ExportMark[]};
}

async function setRange(page: Page, selector: string, value: number): Promise<void> {
  await page.locator(selector).evaluate((element, next) => {
    const input = element as HTMLInputElement;
    input.value = String(next);
    input.dispatchEvent(new Event('input', {bubbles: true}));
    input.dispatchEvent(new Event('change', {bubbles: true}));
  }, value);
}

async function textCenter(page: Page): Promise<{x: number; y: number}> {
  return page.locator('[data-id] text').first().evaluate(node => {
    const rect = (node as SVGGraphicsElement).getBoundingClientRect();
    return {x: rect.x + rect.width / 2, y: rect.y + rect.height / 2};
  });
}

test('arrow size: new default, selected edit, width independence, reload and JSON export', async ({page}) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await openEmptySketch(page);
  const box = await page.locator('#board').boundingBox();
  if (!box) throw new Error('画板没有尺寸');

  await page.locator('[data-tool="arrow"]').click();
  await expect(page.locator('#arrow-size-control')).toBeVisible();
  await setRange(page, '#arrow-size', 40);
  await expect(page.locator('#arrow-size-value')).toHaveText('40 px');
  await page.mouse.move(box.x + 220, box.y + 220);
  await page.mouse.down();
  await page.mouse.move(box.x + 520, box.y + 220, {steps: 6});
  await page.mouse.up();
  await expect(page.locator('#status')).toHaveText('草稿已保存在此设备');
  await expect(page.locator('#selection-arrow-size-control')).toBeVisible();
  await expect(page.locator('#selection-arrow-size')).toHaveValue('40');

  let exported = await exportJson(page);
  expect(exported.marks).toHaveLength(1);
  expect(exported.marks[0]).toMatchObject({shape: 'arrow', size: 40, width: 4});

  await setRange(page, '#selection-arrow-size', 60);
  await expect(page.locator('#status')).toHaveText('草稿已保存在此设备');
  exported = await exportJson(page);
  expect(exported.marks[0].size).toBe(60);
  expect(exported.marks[0].width).toBe(4);

  await page.locator('#edit-selected').click();
  await expect(page.locator('#edit-arrow-size-row')).toBeVisible();
  await expect(page.locator('input[name="arrowSize"]')).toHaveValue('60');
  await page.locator('#edit-dialog [data-close]').click();

  await page.reload();
  await expect(page.locator('main')).not.toHaveAttribute('inert', '');
  await expect(page.locator('[data-id] path')).toHaveCount(1);
  exported = await exportJson(page);
  expect(exported.marks[0].size).toBe(60);
  expect(errors).toEqual([]);
});

test('text font size: 48 then 8, canvas + selection + inline editor + reload stay in sync', async ({page}) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await openEmptySketch(page);
  const box = await page.locator('#board').boundingBox();
  if (!box) throw new Error('画板没有尺寸');

  await page.locator('[data-tool="text"]').click();
  await expect(page.locator('#text-size-control')).toBeVisible();
  await setRange(page, '#text-font-size', 48);
  await page.mouse.click(box.x + 280, box.y + 180);
  await expect(page.locator('#canvas-text')).toBeVisible();
  await page.locator('#canvas-text').fill('标题');
  await page.locator('#canvas-text').press('Enter');
  await expect(page.locator('[data-id] text')).toHaveCount(1);
  await expect(page.locator('[data-id] text')).toHaveAttribute('font-size', '48');
  await expect(page.locator('#selection-text-size-control')).toBeVisible();
  await expect(page.locator('#selection-text-font-size')).toHaveValue('48');

  await setRange(page, '#selection-text-font-size', 8);
  await expect(page.locator('#status')).toHaveText('草稿已保存在此设备');
  await expect(page.locator('[data-id] text')).toHaveAttribute('font-size', '8');
  let exported = await exportJson(page);
  expect(exported.marks[0]).toMatchObject({shape: 'text', fontSize: 8, label: '标题'});

  await page.reload();
  await expect(page.locator('main')).not.toHaveAttribute('inert', '');
  await expect(page.locator('[data-id] text')).toHaveAttribute('font-size', '8');
  exported = await exportJson(page);
  expect(exported.marks[0].fontSize).toBe(8);

  await page.locator('.menu summary').click();
  const [svg] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#export-svg').click()
  ]);
  expect(readFileSync(await svg.path(), 'utf8')).toContain('font-size="8"');

  await page.locator('[data-tool="select"]').click();
  const zoom = Number((await page.locator('#zoom-reset').textContent())!.replace('%', '')) / 100;
  const center = await textCenter(page);
  await page.mouse.dblclick(center.x, center.y);
  await expect(page.locator('#canvas-text')).toBeVisible();
  const editingFont = await page.locator('#canvas-text').evaluate(node =>
    Number.parseFloat(getComputedStyle(node).fontSize));
  expect(editingFont).toBeCloseTo(8 * zoom, 1);
  await page.locator('#canvas-text').press('Escape');
  expect(errors).toEqual([]);
});

test('legacy arrows and text keep their old rendering; 10% zoom still selects text', async ({page}) => {
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
          marks: [
            {id: 'legacy-arrow', shape: 'arrow', kind: 'force', label: '', value: null, unit: '',
              direction: '', question: '', confirmed: false, source: 'manual', layerId: 'layer-default',
              a: [380, 160], b: [580, 160], width: 5},
            {id: 'legacy-text', shape: 'text', kind: 'note', label: '旧文字', value: null, unit: '',
              direction: '', question: '', confirmed: false, source: 'manual', layerId: 'layer-default',
              a: [300, 320]}
          ]
        }, 'draft');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      };
      request.onerror = () => reject(request.error);
    });
  });
  await page.goto('/?renderer=svg');
  await expect(page.locator('main')).not.toHaveAttribute('inert', '');
  await expect(page.locator('[data-id]')).toHaveCount(2);
  await expect(page.locator('[data-id] text')).toHaveAttribute('font-size', '22');

  const exported = await exportJson(page);
  expect(exported.marks.find(mark => mark.shape === 'arrow')?.size).toBeUndefined();
  expect(exported.marks.find(mark => mark.shape === 'text')?.fontSize).toBeUndefined();

  // 10% 下文字仍有点选命中区；点文字中心而不是像素级字形。
  for (let index = 0; index < 30; index++) await page.keyboard.press('-');
  await expect(page.locator('#zoom-reset')).toHaveText('10%');
  await page.locator('[data-tool="select"]').click();
  const center = await textCenter(page);
  await page.mouse.click(center.x, center.y);
  await expect(page.locator('#selection-actions')).toBeVisible();
  await expect(page.locator('#selection-text-size-control')).toBeVisible();
  await expect(page.locator('#selection-text-font-size')).toHaveValue('22');
});
