/**
 * oRPC 客户端的模块级副作用。
 *
 * 请求地址要在真正发请求时才读 `document`。写在模块顶层的话，任何 import
 * 它的模块（包括各个视图）在 node 里一加载就抛 `ReferenceError`，纯函数也
 * 就没法单独测试。这条锁住这一点。
 */
import { describe, expect, test } from "vitest";

import { client, link } from "../src/lib/orpc";

describe("orpc client", () => {
  test("imports without a DOM", () => {
    expect(client).toBeDefined();
    expect(link).toBeDefined();
  });
});
