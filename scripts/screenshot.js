// Logs in and captures the dashboard. Requires Chrome/Chromium (CHROME_PATH, default /usr/bin/google-chrome).
const { chromium } = require('playwright-core');
(async () => {
  const base = process.env.BASE_URL || 'http://localhost:3000';
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const mobile = process.argv.includes('--mobile');
  const page = await browser.newPage(mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' } : { viewport: { width: 1400, height: 1000 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(base);
  await page.fill('input[name=password]', process.env.ADMIN_PASSWORD || 'admin123');
  await page.click('#lf button');
  await page.waitForSelector('#kpis .kpi'); await page.waitForSelector('#t-od tr'); await page.waitForTimeout(500);
  await page.screenshot({ path: __dirname + (mobile ? '/../screenshot-mobile.png' : '/../screenshot.png'), fullPage: !mobile });
  if (mobile) console.log('Page wider than viewport:', await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), '| table scrolls horizontally:', await page.$eval('#t-od', t => t.parentElement.scrollWidth > t.parentElement.clientWidth));
  for (const v of ['loans', 'borrowers', 'repayments']) { await page.click(`nav button[data-v=${v}]`); await page.waitForSelector(`#t-${v} tr:nth-child(2)`); }
  console.log('Rows rendered — loans:', await page.$$eval('#t-loans tr', r => r.length - 1), 'borrowers:', await page.$$eval('#t-borrowers tr', r => r.length - 1), 'repayments:', await page.$$eval('#t-repayments tr', r => r.length - 1));
  console.log(errors.length ? 'JS errors: ' + errors.join('; ') : 'No JS errors');
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
