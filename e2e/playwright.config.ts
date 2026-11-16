import { defineConfig, devices } from "@playwright/test";

/**
 * 端到端用例的配置。
 *
 * 只认 `*.e2e.ts`：vitest 扫的是 `*.test.ts` / `*.spec.ts`，两边不抢文件，
 * 所以 `vp test` 不需要为这里加任何 exclude。
 */
export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: /.*\.e2e\.ts$/u,
  outputDir: "../.e2e/results",
  // 一条用例的上限；超过就是坏，不重试——重试会盖住 flaky 的根因。
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    // 浏览器的 locale 也固定住；应用自己的语言由 localStorage 决定，而每个用例
    // 都是新 context，所以它走的是 i18n 的默认值。
    locale: "en-US",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
});
