import { chromium } from 'playwright';

const page_files = process.argv.slice(2);
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 375, height: 667 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();

for (const f of page_files) {
  await page.goto('file://' + f);
  await page.waitForTimeout(1500); // let webfonts load
  const r = await page.evaluate(() => {
    const out = {
      docScrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      offenders: [],
      probes: {},
    };
    const vw = document.documentElement.clientWidth;
    for (const el of document.querySelectorAll('*')) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0) continue;
      if (rect.right > vw + 1 || rect.left < -1) {
        out.offenders.push({
          tag: el.tagName.toLowerCase(),
          cls: el.className && el.className.baseVal !== undefined ? el.className.baseVal : String(el.className),
          left: +rect.left.toFixed(1),
          right: +rect.right.toFixed(1),
          w: +rect.width.toFixed(1),
        });
      }
    }
    for (const el of document.querySelectorAll('[data-probe]')) {
      const rect = el.getBoundingClientRect();
      out.probes[el.getAttribute('data-probe')] = {
        x: +rect.x.toFixed(1), y: +rect.y.toFixed(1),
        w: +rect.width.toFixed(1), h: +rect.height.toFixed(1),
        bottom: +rect.bottom.toFixed(1), right: +rect.right.toFixed(1),
      };
    }
    return out;
  });
  console.log('=====', f.split('/').pop(), '=====');
  console.log(JSON.stringify(r, null, 1));
}
await browser.close();
