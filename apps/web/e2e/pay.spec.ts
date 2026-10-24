import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

const token = fs.readFileSync(path.join(__dirname, 'pay-token.txt'), 'utf8').trim();

test('a parent chooses Telebirr or CBE Birr and never sees a provider name', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto(`/pay/${token}`);
  await expect(page.getByText('Telebirr · ቴሌብር')).toBeVisible();
  await expect(page.getByText('CBE Birr · ሲቢኢ ብር')).toBeVisible();
  await expect(page.getByText('የክፍያ መንገድ')).toBeVisible();
  const body = (await page.locator('body').innerText()).toLowerCase();
  expect(body).not.toContain('arifpay');
  expect(body).not.toContain('chapa');

  await page.getByLabel('Your full name · ሙሉ ስም').fill('Kebede Alemu');
  await page.getByLabel('Phone number · ስልክ ቁጥር').fill('0712345678');
  await page.getByRole('button', { name: /ክፈል/ }).click();
  await expect(page.getByText('Telebirr needs an Ethio Telecom number starting with 09')).toBeVisible({ timeout: 25_000 });
  await expect(page).toHaveURL(new RegExp(`/pay/${token}`));

  await page.getByLabel('Your full name · ሙሉ ስም').fill('Kebede Alemu');
  await page.getByLabel('Phone number · ስልክ ቁጥር').fill('0912345678');
  await page.getByRole('button', { name: /ክፈል/ }).click();
  await page.waitForURL(/\/dev\/checkout\//, { timeout: 30_000 });
});
