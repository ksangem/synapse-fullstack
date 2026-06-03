// Headless browser verification for T-07 (Dashboard + Registry on live data).
// Run from packages/backend:  node src/scripts/verify-t07.mjs
import { chromium } from 'playwright';

const BASE = 'http://localhost:5173';
const results = {};
const browser = await chromium.launch();
const page = await browser.newPage();

async function check(route, key) {
  await page.goto(`${BASE}${route}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1800); // let the /api/connected fetch resolve + render
  const body = await page.innerText('body');
  results[`${key}_live_badge`] = body.includes('Live');
  results[`${key}_sample_badge`] = body.includes('Sample data');
  results[`${key}_integration_name`] = body.includes('ananthu sp');
  await page.screenshot({ path: `verify-${key}.png`, fullPage: true });
}

await check('/registry', 'registry');
await check('/dashboard', 'dashboard');

console.log(JSON.stringify(results, null, 2));
await browser.close();
