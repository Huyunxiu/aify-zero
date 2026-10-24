import { createApp } from "../src/app";

export const TEST_API_TOKEN = "test-api-token";

/** 测试用 app：注入固定 token，避免读写 `~/.aify-zero/api-token`。 */
export const testApp = createApp({ apiToken: () => TEST_API_TOKEN });

export const authHeaders = {
  authorization: `Bearer ${TEST_API_TOKEN}`,
} as const;
