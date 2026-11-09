/**
 * 最小 MCP 服务器，只给 stdio 冒烟测试用。
 *
 * 实现 initialize、tools/list、tools/call 三个方法，其余方法一律回 JSON-RPC
 * 错误 —— 这正是老服务器对 `server/discover` 的反应，客户端应当退回到普通
 * 握手。消息按行分隔，一行一条 JSON。
 */
const tools = [
  {
    name: "echo",
    description: "Echo back the message.",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
    },
    annotations: { readOnlyHint: true },
  },
];

let buffer = "";

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handle(message) {
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "echo-fixture", version: "1.0.0" },
      },
    });
    return;
  }

  if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools } });
    return;
  }

  if (message.method === "tools/call") {
    const text = message.params?.arguments?.message ?? "";
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { content: [{ type: "text", text: `echo: ${text}` }] },
    });
    return;
  }

  // 通知没有 id，不需要应答。
  if (message.id !== undefined) {
    send({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32_601, message: `unknown method ${message.method}` },
    });
  }
}

process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;

  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line !== "") {
      handle(JSON.parse(line));
    }
    newline = buffer.indexOf("\n");
  }
});
