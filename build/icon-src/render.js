const path = require('path');
const { chromium } = require('playwright');

const variants = [
  { html: 'icon.html', out: 'icon-1024.png' },
  { html: 'icon-small.html', out: 'icon-1024-small.png' },
];

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  for (const v of variants) {
    const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
    await page.goto('file://' + path.join(__dirname, v.html));
    await page.screenshot({ path: path.join(__dirname, v.out), omitBackground: true });
    await page.close();
  }
  await browser.close();
  console.log('done');
})();
