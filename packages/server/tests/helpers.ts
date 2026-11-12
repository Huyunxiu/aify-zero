import { createApp } from "../src/app";

export const TEST_API_TOKEN = "test-api-token";

/**
 * 测试用 app：注入固定 token，避免读写 `~/.aify-zero/api-token`。
 *
 * 关闭静态托管和环境推导：测试只关心 API，页面和真实环境变量不该影响断言。
 */
export const testApp = createApp({
  apiToken: () => TEST_API_TOKEN,
  env: {},
  webRoot: null,
});

export const authHeaders = {
  authorization: `Bearer ${TEST_API_TOKEN}`,
} as const;
