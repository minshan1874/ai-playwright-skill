/**
 * Regression tests for the generated Playwright config.
 *
 * The HTML reporter's option is `outputFolder`. Misspelling it as `outputDir`
 * makes Playwright silently fall back to a default location, so the report ends
 * up somewhere the agent never looks — exactly the kind of bug that only shows up
 * after a real browser run. These tests pin the option names.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { mergeConfig } from '../skill/scripts/lib/config.mjs';
import { renderPlaywrightConfig } from '../skill/scripts/lib/playwright-config.mjs';

const PATHS = {
  specs: '/runs/x/specs',
  testResults: '/runs/x/test-results',
  jsonResults: '/runs/x/test-results/results.json',
  htmlReport: '/runs/x/playwright-report',
};

/** Render with sensible defaults, overriding only what a test cares about. */
function render(overrides = {}, configOverrides = {}) {
  return renderPlaywrightConfig({
    paths: PATHS,
    config: mergeConfig({ baseURL: 'https://x.test', ...configOverrides }),
    authStatePath: null,
    hasAuthSetup: false,
    ...overrides,
  });
}

describe('playwright config generation', () => {
  it('uses outputFolder for the HTML reporter, never outputDir', () => {
    const source = render();
    assert.ok(source.includes("['html', { outputFolder: \"/runs/x/playwright-report\", open: 'never' }]"));
    assert.ok(!/outputDir:\s*"\/runs\/x\/playwright-report"/.test(source));
  });

  it('uses outputFile for the JSON reporter', () => {
    assert.ok(render().includes("['json', { outputFile: \"/runs/x/test-results/results.json\" }]"));
  });

  it('points testDir and outputDir at the run directory', () => {
    const source = render();
    assert.ok(source.includes('testDir: "/runs/x/specs"'));
    assert.ok(source.includes('outputDir: "/runs/x/test-results"'));
  });

  it('creates one project per configured browser', () => {
    const source = render({}, { browsers: ['chromium', 'firefox'] });
    assert.ok(source.includes("name: \"chromium\""));
    assert.ok(source.includes("name: \"firefox\""));
    assert.ok(source.includes('browserName: "chromium"'));
    assert.ok(source.includes('browserName: "firefox"'));
    assert.ok(!source.includes("name: 'setup'"));
  });

  it('adds a setup project and dependencies when auth setup is generated', () => {
    const source = render({ authStatePath: '/home/auth/x.json', hasAuthSetup: true });
    assert.ok(source.includes("name: 'setup'"));
    assert.ok(source.includes('testMatch: /_auth\\.setup\\.ts/'));
    assert.ok(source.includes("dependencies: ['setup']"));
    // The main projects must not pin a storageState the setup has not written yet.
    assert.ok(!source.includes('storageState:'));
  });

  it('reuses an existing storageState without a setup project', () => {
    const source = render({ authStatePath: '/home/auth/x.json', hasAuthSetup: false });
    assert.ok(source.includes('storageState: "/home/auth/x.json"'));
    assert.ok(!source.includes("name: 'setup'"));
  });

  it('carries the run settings through', () => {
    const source = render({}, { timeout: 45000, retries: 3, workers: 2, headless: false });
    assert.ok(source.includes('timeout: 45000'));
    assert.ok(source.includes('retries: 3'));
    assert.ok(source.includes('workers: 2'));
    assert.ok(source.includes('headless: false'));
  });

  it('strips a trailing slash from the base URL', () => {
    assert.ok(render({}, { baseURL: 'https://x.test///' }).includes('baseURL: "https://x.test"'));
  });

  it('is valid TypeScript-shaped output that imports defineConfig', () => {
    const source = render();
    assert.ok(source.startsWith('//'));
    assert.ok(source.includes("import { defineConfig } from '@playwright/test';"));
    assert.ok(source.includes('export default defineConfig({'));
    assert.ok(source.trimEnd().endsWith('});'));
    // Balanced braces are a cheap smoke test for a broken template.
    assert.equal((source.match(/\{/g) ?? []).length, (source.match(/\}/g) ?? []).length);
  });

  it('escapes paths that contain a quote', () => {
    const source = renderPlaywrightConfig({
      paths: { ...PATHS, specs: '/runs/we"ird/specs' },
      config: mergeConfig({ baseURL: 'https://x.test' }),
      authStatePath: null,
      hasAuthSetup: false,
    });
    assert.ok(source.includes('testDir: "/runs/we\\"ird/specs"'));
  });
});
