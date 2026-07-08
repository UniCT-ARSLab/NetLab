const path = require('path');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
  await page.goto('file://' + path.join(__dirname, 'icon.html'));
  await page.screenshot({ path: path.join(__dirname, 'icon-1024.png'), omitBackground: true });
  await browser.close();
  console.log('done');
})();
