/**
 * 终端 WebSocket 的线上协议。
 *
 * 方向和帧类型不对称，原因是两边的传输实现不同：
 *
 * - 客户端用 `@wterm/core` 的 `WebSocketTransport`。它发送字符串时也会先编码
 *   成 UTF-8，再发二进制帧，所以客户端只能发二进制。这里用首字节区分输入和
 *   控制消息。
 * - 服务端可以自己选择帧类型。PTY 输出走二进制，控制消息走文本 JSON，浏览器
 *   端不需要再解一层信封。
 *
 * 客户端帧：
 *
 * ```text
 * [0x01][输入字节]
 * [0x02][UTF-8 JSON 控制消息]
 * ```
 *
 * 服务端帧：
 *
 * ```text
 * 二进制：[PTY 输出字节]
 * 文本：  {"type":"ready"|"exit"|"error", ...}
 * ```
 *
 * 协议只描述字节，不依赖 Node 或浏览器专属 API，两个进程共用同一份定义。
 */

/** 客户端输入帧的标签。 */
export const TERMINAL_INPUT_FRAME = 0x01;

/** 客户端控制帧的标签。 */
export const TERMINAL_CONTROL_FRAME = 0x02;

/** 一条控制消息的字节上限；超过说明协议已不同步。 */
export const TERMINAL_CONTROL_LIMIT = 4096;

/** 终端行列数的上限；防止异常 resize 把核心撑爆。 */
export const TERMINAL_MAX_DIMENSION = 4096;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** 客户端发给服务端的 resize 控制消息。 */
export interface TerminalResizeControl {
  readonly cols: number;
  readonly rows: number;
  readonly type: "resize";
}

/** 客户端目前只发 resize；以后加控制消息时扩展这个联合。 */
export type TerminalClientControl = TerminalResizeControl;

/** 服务端在会话建立后报告 PTY 的初始状态。 */
export interface TerminalReadyControl {
  readonly cwd: string;
  readonly pid: number;
  readonly type: "ready";
}

/** shell 退出。服务端随后关闭连接。 */
export interface TerminalExitControl {
  readonly exitCode: number;
  readonly type: "exit";
}

/** 会话无法建立或处理输入时的错误。 */
export interface TerminalErrorControl {
  readonly message: string;
  readonly type: "error";
}

/** 服务端发给客户端的控制消息。 */
export type TerminalServerControl =
  | TerminalReadyControl
  | TerminalExitControl
  | TerminalErrorControl;

/** `decodeTerminalFrame` 的结果。 */
export type TerminalClientFrame =
  | { readonly data: Uint8Array; readonly kind: "input" }
  | { readonly control: TerminalClientControl; readonly kind: "control" };

const isDimension = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= 1 &&
  value <= TERMINAL_MAX_DIMENSION;

/**
 * 把一条客户端控制消息编码成带标签的二进制帧。
 *
 * @param control - 目前只有 resize。
 * @returns 可以直接交给 `WebSocketTransport.send` 的帧。
 */
export function encodeTerminalControl(
  control: TerminalClientControl
): Uint8Array {
  if (!isDimension(control.cols) || !isDimension(control.rows)) {
    throw new RangeError("terminal: resize dimensions are out of range");
  }

  const payload = encoder.encode(
    JSON.stringify({
      cols: control.cols,
      rows: control.rows,
      type: control.type,
    })
  );

  if (payload.byteLength > TERMINAL_CONTROL_LIMIT) {
    throw new RangeError("terminal: control message is too large");
  }

  const frame = new Uint8Array(payload.byteLength + 1);
  frame[0] = TERMINAL_CONTROL_FRAME;
  frame.set(payload, 1);

  return frame;
}

/**
 * 把键盘输入编码成带标签的二进制帧。
 *
 * 字符串和字节都接受：文本输入走字符串，鼠标等原始报告走字节。帧的内容不做
 * 转义，PTY 收到的就是原始字节。
 *
 * @param data - 一段完整输入。
 * @returns 可以直接交给 `WebSocketTransport.send` 的帧。
 */
export function encodeTerminalInput(data: string | Uint8Array): Uint8Array {
  const payload = typeof data === "string" ? encoder.encode(data) : data;
  const frame = new Uint8Array(payload.byteLength + 1);
  frame[0] = TERMINAL_INPUT_FRAME;
  frame.set(payload, 1);

  return frame;
}

/**
 * 解析一帧客户端数据。
 *
 * @param frame - WebSocket 收到的完整二进制帧。
 * @returns 输入字节或校验过的控制消息。
 * @throws {Error} 空帧、未知标签、超长控制消息或非法 JSON。
 */
export function decodeTerminalFrame(frame: Uint8Array): TerminalClientFrame {
  if (frame.byteLength === 0) {
    throw new Error("terminal: frame is empty");
  }

  const [tag] = frame;
  const payload = frame.subarray(1);

  if (tag === TERMINAL_INPUT_FRAME) {
    return { data: payload, kind: "input" };
  }

  if (tag !== TERMINAL_CONTROL_FRAME) {
    throw new Error(`terminal: unknown frame tag ${String(tag)}`);
  }

  if (payload.byteLength > TERMINAL_CONTROL_LIMIT) {
    throw new Error("terminal: control message is too large");
  }

  return { control: parseTerminalControl(payload), kind: "control" };
}

/**
 * 解析控制帧里的 JSON。
 *
 * 校验是严格的：多一个字段就拒绝，避免两边对协议内容的理解慢慢漂移。
 *
 * @param payload - 标签之后的字节。
 * @returns 校验过的控制消息。
 */
function parseTerminalControl(payload: Uint8Array): TerminalClientControl {
  let decoded: unknown;

  try {
    decoded = JSON.parse(decoder.decode(payload));
  } catch (error) {
    throw new Error("terminal: control message is not JSON", { cause: error });
  }

  if (
    typeof decoded !== "object" ||
    decoded === null ||
    Array.isArray(decoded)
  ) {
    throw new Error("terminal: control message must be a JSON object");
  }

  const record = decoded as Record<string, unknown>;

  if (record.type !== "resize") {
    throw new Error("terminal: unsupported control message");
  }

  for (const key of Object.keys(record)) {
    if (key !== "type" && key !== "cols" && key !== "rows") {
      throw new Error(`terminal: unexpected control field "${key}"`);
    }
  }

  if (!isDimension(record.cols) || !isDimension(record.rows)) {
    throw new Error("terminal: resize dimensions are out of range");
  }

  return { cols: record.cols, rows: record.rows, type: "resize" };
}

/**
 * 把服务端控制消息编码成文本帧内容。
 *
 * @param control - `ready`、`exit` 或 `error`。
 * @returns 放进文本帧的 JSON。
 */
export function encodeTerminalServerControl(
  control: TerminalServerControl
): string {
  return JSON.stringify(control);
}

/**
 * 解析服务端控制消息。
 *
 * 客户端收到不认识的消息时返回 `null` 并继续读。服务端新增可选消息不应该让
 * 旧页面直接断开。
 *
 * @param raw - 完整文本帧。
 * @returns 校验过的控制消息；不认识时为 `null`。
 */
export function parseTerminalServerControl(
  raw: string
): TerminalServerControl | null {
  if (raw.length > TERMINAL_CONTROL_LIMIT) {
    return null;
  }

  let decoded: unknown;

  try {
    decoded = JSON.parse(raw);
  } catch {
    return null;
  }

  if (
    typeof decoded !== "object" ||
    decoded === null ||
    Array.isArray(decoded)
  ) {
    return null;
  }

  const record = decoded as Record<string, unknown>;

  if (record.type === "ready") {
    if (
      typeof record.cwd !== "string" ||
      typeof record.pid !== "number" ||
      !Number.isInteger(record.pid) ||
      record.pid < 0
    ) {
      return null;
    }

    return { cwd: record.cwd, pid: record.pid, type: "ready" };
  }

  if (record.type === "exit") {
    if (
      typeof record.exitCode !== "number" ||
      !Number.isInteger(record.exitCode)
    ) {
      return null;
    }

    return { exitCode: record.exitCode, type: "exit" };
  }

  if (record.type === "error") {
    if (typeof record.message !== "string") {
      return null;
    }

    return { message: record.message, type: "error" };
  }

  return null;
}
