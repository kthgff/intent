import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const outputDir = path.resolve(
  here,
  '../../../docs/design/mockups/dashboard-focus',
);
const baseUrl = process.env.INTENT_DEMO_URL ?? 'http://127.0.0.1:4173';
const executablePath =
  process.env.INTENT_CHROME_PATH ??
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const desktop = [
  ['dashboard-populated.png', '/'],
  ['dashboard-empty.png', '/?scenario=empty'],
  ['ticket-focus-normal.png', '/tickets/team-a/SR-0133'],
  ['ticket-focus-attention.png', '/tickets/team-a/SR-0142'],
  [
    'ticket-focus-documentation.png',
    '/tickets/team-a/SR-0133',
    'Documentation',
  ],
];

const compact = [
  ['dashboard-populated-compact.png', '/'],
  ['ticket-focus-attention-compact.png', '/tickets/team-a/SR-0142'],
];

function demoUrl(route) {
  const url = new URL(route, baseUrl);
  url.searchParams.set('demo', '1');
  return url.href;
}

async function captureSet(browser, captures, viewport, errors) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    colorScheme: 'dark',
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  let currentFile = 'initialization';
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(`${currentFile} console: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => {
    errors.push(`${currentFile} page: ${error.message}`);
  });

  for (const [filename, route, tab] of captures) {
    currentFile = filename;
    await page.goto(demoUrl(route), { waitUntil: 'networkidle' });
    if (tab) await page.getByRole('tab', { name: tab }).click();
    await page.evaluate(() => document.fonts.ready);
    const pageOverflows = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    if (pageOverflows)
      errors.push(`${filename}: page-level horizontal overflow`);
    await page.screenshot({
      path: path.join(outputDir, filename),
      fullPage: false,
      animations: 'disabled',
    });
    process.stdout.write(`captured ${filename}\n`);
  }

  await context.close();
}

await mkdir(outputDir, { recursive: true });
const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ['--hide-scrollbars', '--disable-background-networking'],
});
const errors = [];

await captureSet(browser, desktop, { width: 1440, height: 1024 }, errors);
await captureSet(browser, compact, { width: 1024, height: 768 }, errors);

const navigationContext = await browser.newContext({
  viewport: { width: 1440, height: 1024 },
  reducedMotion: 'reduce',
});
const navigationPage = await navigationContext.newPage();
await navigationPage.goto(demoUrl('/'), { waitUntil: 'networkidle' });
await navigationPage.locator('.d-card', { hasText: 'SR-0142' }).click();
await navigationPage.waitForURL('**/tickets/team-a/SR-0142?demo=1');
if (
  !(await navigationPage
    .getByText('Which cache backend should sessions use?')
    .isVisible())
) {
  errors.push('navigation: SR-0142 card did not reveal its attention panel');
}
await navigationContext.close();
await browser.close();

if (errors.length > 0) {
  process.stderr.write(`${errors.join('\n')}\n`);
  process.exitCode = 1;
}
