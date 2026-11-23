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

test('adding one object over the draft budget is rejected instead of silently dropped', async ({page}) => {
  const shapes = Array.from({length: 5000}, (_, index) => ({
    id: `seed-${index}`, type: 'rect', layerId: 'layer-default', color: '#2e4f77',
    strokeWidth: 1, a: [20 + index * 0.02, 20], b: [21 + index * 0.02, 21]
  }));
  await seedProject(page, {layers: [{id: 'layer-default', name: '图层 1', opacity: 1}], shapes});
  await expect(page.locator('[data-shape-id]')).toHaveCount(5000);

  const box = await page.locator('#board').boundingBox();
  if (!box) throw new Error('画板没有尺寸');
  await page.locator('button[data-tool="rect"]').click();
  await page.mouse.move(box.x + 300, box.y + 220);
  await page.mouse.down();
  await page.mouse.move(box.x + 430, box.y + 310, {steps: 6});
  await page.mouse.up();

  await expect(page.locator('#notice')).toContainText('草稿已达上限');
  await expect(page.locator('[data-shape-id]')).toHaveCount(5000);

  // 拒绝新增后仍可正常撤销回同一状态，不会出现“看似保存成功”的空历史。
  await page.keyboard.press('Control+z');
  await expect(page.locator('[data-shape-id]')).toHaveCount(5000);
});
