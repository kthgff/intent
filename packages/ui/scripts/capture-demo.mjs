import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const outputDir = path.resolve(here, '../../../docs/design/mockups');
const baseUrl = process.env.INTENT_DEMO_URL ?? 'http://127.0.0.1:4173';
const executablePath =
  process.env.INTENT_CHROME_PATH ??
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const screens = [
  ['s-01-inbox.png', '/'],
  ['s-02-settings.png', '/settings'],
  ['s-03-create-import.png', '/new'],
  ['s-04-qa-wizard.png', '/tickets/team-a/SR-0142/wizard'],
  ['s-05-ticket-detail.png', '/tickets/team-a/SR-0142'],
  ['s-06-doc-review.png', '/tickets/team-a/SR-0142/docs/prd.md'],
  ['s-07-run-monitor.png', '/runs/run-impl-142'],
  ['s-08-code-review.png', '/tickets/team-a/SR-0142/review'],
  ['s-09-pr-panel.png', '/tickets/team-a/SR-0142/pr'],
  ['s-10-escalations.png', '/queue'],
  ['s-11-ledger.png', '/ledger'],
  ['s-12-metrics.png', '/metrics'],
  ['s-13-workspaces.png', '/workspaces'],
  ['s-14-knowledge-base.png', '/kb'],
];

const compactScreens = [
  ['s-01-inbox-compact.png', '/'],
  ['s-05-ticket-detail-compact.png', '/tickets/team-a/SR-0142'],
  ['s-08-code-review-compact.png', '/tickets/team-a/SR-0142/review'],
  ['s-14-knowledge-base-compact.png', '/kb'],
];

async function captureSet(browser, captures, viewport) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    colorScheme: 'dark',
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => errors.push(`page: ${error.message}`));

  for (const [filename, route] of captures) {
    const separator = route.includes('?') ? '&' : '?';
    await page.goto(`${baseUrl}${route}${separator}demo=1`, {
      waitUntil: 'networkidle',
    });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({
      path: path.join(outputDir, filename),
      fullPage: false,
      animations: 'disabled',
    });
    process.stdout.write(`captured ${filename}\n`);
  }

  await context.close();
  return errors;
}

await mkdir(outputDir, { recursive: true });
const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ['--hide-scrollbars', '--disable-background-networking'],
});

const errors = [
  ...(await captureSet(browser, screens, { width: 1440, height: 1024 })),
  ...(await captureSet(browser, compactScreens, { width: 1024, height: 768 })),
];

await browser.close();

if (errors.length > 0) {
  process.stderr.write(`${errors.join('\n')}\n`);
  process.exitCode = 1;
}
