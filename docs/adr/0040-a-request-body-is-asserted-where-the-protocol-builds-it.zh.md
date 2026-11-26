# 请求体的断言放在协议造它的那层

中文副本。以 `0040-a-request-body-is-asserted-where-the-protocol-builds-it.md` 为准。

`AIFY0-137`（ADR 0039）把工具结果里的文件为 chat 协议挪进了 user 消息，而守住它的测试停在
「交给 `streamText` 的 messages」。那些 messages 不是离开进程的东西。供应商适配器把它们变成 HTTP
请求体，缺陷正住在那里：除非设了 `supportsMultiPartToolContent`，`@ai-sdk/openai-compatible`
会把工具结果的内容序列化成文本。SDK 哪天改了这个默认值，守卫会一直是绿的，而模型又在读 base64。

仓库自己记过这段空白。`ADR 0011` 写着：测试把 `streamText` 换掉，从 `gateway.ts` 到
`OpenAICompatibleChatLanguageModel` 这条路一个测试都没有。它该落在
`docs/testing/fake-provider.md` 四层表里的第三层「协议与 HTTP」，而那一层此前只往假供应商直接
POST 过。

于是有一个用例让真 Agent 经真 HTTP 请求打到假供应商，读 `read-file` 调用之后那次请求的请求体：
工具消息里没有 file part，它后面那条是带 `image_url` 的 `user` 消息。file part 就是缺陷，因为
chat 协议会把它写成文本塞进消息。假供应商会记下它应答过的每个请求解析后的体，所以
断言读那次请求被记下的体，不走旁路。

## 考虑过的方案

- **给 provider 注入 `fetch`，读 `result.request.body`**：不用端口，SDK 也把体交回来。但需要
  一段写死的 SSE 响应，等于多出第二个知道 chat 协议怎么分帧的地方；`ADR 0011` 存在的理由就是
  让这份知识每种协议只有一份写手。
- **用 `msw` 拦 `fetch`**：同样不用端口，也能断言体。`ADR 0011` 否过一次，理由仍然成立：它拦
  的是库的调用而不是协议，它也服务不了手动流程，而且分帧还得自己写。
- **`ai/test` 的 `MockLanguageModelV4`**：最小的替身。它替掉的正是模型对象，也就是造体的那段
  代码，所以这个缺陷它永远抓不到。
- **CI 里打真供应商**：证据最强。但要花钱、结果不确定，而 `ADR 0011` 的录制模式已经能为假供应
  商造不出的形状回放一份抓下来的响应。
- **经 HTTP 打假供应商**（本决定）：不复制协议知识，秒级，线上一改就会红。

## 后果

- 用例红了就意味着请求体变了，而不是某个内部形状变了。这正是这道守卫要的信号。
- 假供应商在一个用例的生命周期内保留它应答过的每个体。场景本身没有大小上限，所以读大图的用例
  会把它们留在内存里；测试都很短。
- 浏览器套件 seed 的模型声明能读图。否则读图的用例会在图片被请求装配换成一句话时照样通过。
- 只覆盖 chat。假供应商只会说一种协议，`responses` 的写手是另一件事；在那之前 responses 这条
  路继续由请求装配层的测试守住。
