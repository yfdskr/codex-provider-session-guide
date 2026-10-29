import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './ui-test', outputDir: '.ui-test-results', workers: 1, reporter: 'list', use: { browserName: 'chromium', headless: true, viewport: { width: 1440, height: 1050 }, colorScheme: 'dark' } });
