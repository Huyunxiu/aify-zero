import { asSchema } from "ai";
import type { JSONSchema7, Tool, ToolSet } from "ai";

import type { ToolExposure } from "../types";

/** 工具名里命名空间与工具名的分隔符，和 MCP 工具名同一套。 */
const NAME_SEPARATOR = "__";

/** 单条签名的上限：再长就截断，它只是让模型拼对 `input` 的提示。 */
const MAX_SIGNATURE_LENGTH = 400;

/**
 * 目录里的一条。
 *
 * 它是模型能看见的全部：名字、一行说明、参数签名。完整的 JSON Schema 不给，
 * 那等于把藏起来的工具又搬回上下文。
 */
export type CatalogEntry = {
  name: string;
  /** `服务器名__工具名` 里的服务器名；名字里没有分隔符时为空。 */
  namespace?: string;
  description: string;
  /** 紧凑参数签名，例如 `{ query: string, limit?: number }`；没有入参时为空串。 */
  signature: string;
};

/**
 * 这个 agent 放进目录的那些工具，按注册顺序。
 *
 * 成员关系由暴露方式决定，不另存一份名单：注册成 `deferred` 的工具就在目录里。
 */
export function catalogEntries(
  tools: ToolSet,
  exposure: ReadonlyMap<string, ToolExposure>
): CatalogEntry[] {
  const entries: CatalogEntry[] = [];

  for (const [name, tool] of Object.entries(tools)) {
    if (exposure.get(name) !== "deferred") {
      continue;
    }

    entries.push({
      name,
      namespace: namespaceOf(name),
      description: firstLine(tool.description),
      signature: renderSignature(tool),
    });
  }

  return entries;
}

/** 名字里的命名空间；没有分隔符时返回 undefined。 */
export function namespaceOf(name: string): string | undefined {
  const at = name.indexOf(NAME_SEPARATOR);

  return at > 0 ? name.slice(0, at) : undefined;
}

/**
 * 名字里分隔符之后的那一段。
 *
 * 没有分隔符时就是整个名字——不能退到 `slice(1)`，那会让任何「去掉首字母后
 * 相同」的名字误命中按短名搜索的那一档。
 */
export function bareNameOf(name: string): string {
  const at = name.indexOf(NAME_SEPARATOR);

  return at > 0 ? name.slice(at + NAME_SEPARATOR.length) : name;
}

/**
 * `"linear__"` 这样的服务器前缀查询，给出 `linear`；不是前缀查询时返回
 * undefined。前缀查询跳过排序，直接列这台服务器的工具。
 */
export function queryNamespace(query: string): string | undefined {
  if (!query.endsWith(NAME_SEPARATOR)) {
    return undefined;
  }

  const namespace = query.slice(0, -NAME_SEPARATOR.length);

  return namespace.length > 0 ? namespace : undefined;
}

/**
 * 把工具的入参摊成名字和类型。
 *
 * 嵌套的形状只留一个类型词：模型需要完整形状时，校验错误会把那个参数指出来；
 * 把完整 schema 抄进签名，等于把省下来的上下文又花回去。
 */
export function renderSignature(tool: Tool): string {
  const written = asSchema(tool.inputSchema).jsonSchema;

  // 异步 schema 要到请求时才求值，目录是同步构建的：给它一个空签名，
  // 而不是把「还不知道」写成参数。
  if (isPromiseLike(written)) {
    return "";
  }

  const { properties } = written;
  if (!properties) {
    return "";
  }

  const required = new Set(written.required);
  const parts: string[] = [];

  for (const [name, definition] of Object.entries(properties)) {
    const mark = required.has(name) ? "" : "?";
    parts.push(`${name}${mark}: ${typeOf(definition)}`);
  }

  if (parts.length === 0) {
    return "{}";
  }

  const signature = `{ ${parts.join(", ")} }`;

  return signature.length > MAX_SIGNATURE_LENGTH
    ? `${signature.slice(0, MAX_SIGNATURE_LENGTH - 1)}…`
    : signature;
}

function isPromiseLike(
  schema: JSONSchema7 | PromiseLike<JSONSchema7>
): schema is PromiseLike<JSONSchema7> {
  return "then" in schema;
}

/** 字面量的显示形式；对象和数组按 JSON 打，避免出现 `[object Object]`。 */
function showValue(value: unknown): string {
  return typeof value === "string" ? value : (JSON.stringify(value) ?? "");
}

/** 一个值是什么，或者它能取哪几个字面量。 */
function typeOf(definition: JSONSchema7Definition): string {
  if (typeof definition === "boolean") {
    return "unknown";
  }

  if (definition.enum) {
    const shown = definition.enum.slice(0, 3).map(showValue);
    const rest = definition.enum.length - shown.length;

    return `${shown.join(" | ")}${rest > 0 ? ` | …${rest} more` : ""}`;
  }

  const nested = definition.anyOf ?? definition.oneOf;
  if (nested) {
    return [...new Set(nested.map((one) => typeOf(one)))].join(" | ");
  }

  const { type } = definition;
  if (Array.isArray(type)) {
    return type.join(" | ");
  }

  if (type === "array") {
    // 参数里放数组的对象工具很少见，写出元素类型只会把签名撑长。
    return "array";
  }

  return type ?? "unknown";
}

type JSONSchema7Definition = JSONSchema7 | boolean;

/** 说明只取第一行：目录只用来找工具，不是文档。 */
function firstLine(description: Tool["description"]): string {
  if (typeof description !== "string" || description.length === 0) {
    return "";
  }

  const [line] = description.trim().split("\n");

  return line ?? "";
}
