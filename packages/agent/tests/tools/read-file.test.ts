import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import type { AgentContext } from "../../src/agent-context";
import { createReadFileTool } from "../../src/tools/read-file";
import { testSandbox } from "../helpers/sandbox.js";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "aify-read-file-"));
  tempDirs.push(dir);
  return dir;
}

function readTool(dir: string) {
  const agentContext = {
    sessionId: "session-1",
    projectDirs: [dir],
    primaryProjectDir: dir,
    sessionDir: dir,
    sandbox: testSandbox(dir),
  } as unknown as AgentContext;

  return createReadFileTool({ agentContext });
}

async function read(dir: string, path: string) {
  const tool = readTool(dir);
  const execute = tool.execute as unknown as (
    input: { path: string },
    options: unknown
  ) => Promise<{ output: string; code: string }>;

  return await execute({ path }, { toolCallId: "call-1", messages: [] });
}

describe("read-file and links", () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
    );
  });

  test("should report a broken link as a miss, not as a tool failure", async () => {
    const dir = await createTempDir();
    await symlink(join(dir, "gone.txt"), join(dir, "broken.txt"));

    // `stat` 对坏链接会如实回报链接本身（isFile 与 isDirectory 都为 false）。
    // 工具必须把它当成「找不到文件」，而不是接着去读一个读不出来的目标。
    const result = await read(dir, "broken.txt");

    expect(result.code).toBe("error");
    expect(result.output).toContain("File not found");
  });

  test("should follow a link to a file", async () => {
    const dir = await createTempDir();
    await writeFile(join(dir, "real.txt"), "content\n", "utf-8");
    await symlink(join(dir, "real.txt"), join(dir, "link.txt"));

    const result = await read(dir, "link.txt");

    expect(result.code).toBe("ok");
    expect(result.output).toContain("content");
  });
});

/** 1x1 red PNG: a valid signature, IHDR, and IDAT that `file-type` recognises. */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  "base64"
);

/** A PNG whose IHDR declares a size but whose pixels are absent. */
function pngHeader(width: number, height: number): Buffer {
  const header = Buffer.alloc(33);
  PNG_1X1.copy(header, 0, 0, 8);
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12, "ascii");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  header.set([8, 2, 0, 0, 0], 24);
  return header;
}

function imageTool(dir: string, inputKinds: readonly string[]) {
  const agentContext = {
    sessionId: "session-1",
    projectDirs: [dir],
    primaryProjectDir: dir,
    sessionDir: dir,
    inputKinds,
    sandbox: testSandbox(dir),
  } as unknown as AgentContext;

  return createReadFileTool({ agentContext });
}

async function readImage(
  dir: string,
  path: string,
  inputKinds: readonly string[] = ["text", "image"]
) {
  const tool = imageTool(dir, inputKinds);
  const execute = tool.execute as unknown as (
    input: { path: string; offset?: number; limit?: number },
    options: unknown
  ) => Promise<Record<string, unknown>>;

  return await execute({ path }, { toolCallId: "call-1", messages: [] });
}

describe("read-file and image attachments", () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
    );
  });

  test("should commit the bytes once and report the size in the envelope", async () => {
    const dir = await createTempDir();
    await writeFile(join(dir, "red.png"), PNG_1X1);

    const result = await readImage(dir, "red.png");
    const attachments = result.attachments as Record<string, unknown>[];

    expect(result.code).toBe("ok");
    expect(result.output).toContain("<type>image</type>");
    expect(result.output).toContain("image/png, 1x1 px, 69 bytes");
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({
      type: "attachment",
      mediaType: "image/png",
      width: 1,
      height: 1,
      bytes: PNG_1X1.byteLength,
      owner: "session:session-1",
    });
  });

  test("should store the bytes under their digest and leave one object after a second read", async () => {
    const dir = await createTempDir();
    await writeFile(join(dir, "red.png"), PNG_1X1);

    const result = await readImage(dir, "red.png");
    const [attachment] = result.attachments as { sha256: string }[];
    const sha = attachment?.sha256 ?? "";
    const stored = await readFile(join(dir, "attachments", sha));

    await readImage(dir, "red.png");

    expect(stored.byteLength).toBe(PNG_1X1.byteLength);
    await expect(readdir(join(dir, "attachments"))).resolves.toStrictEqual([
      sha,
    ]);
  });

  test("should refuse an image when the route takes no image input", async () => {
    const dir = await createTempDir();
    await writeFile(join(dir, "red.png"), PNG_1X1);

    await expect(readImage(dir, "red.png", ["text"])).rejects.toThrow(
      /does not accept image input/u
    );

    // The refusal comes before the bytes are read, so nothing is stored.
    await expect(readdir(join(dir, "attachments"))).rejects.toThrow(/ENOENT/u);
  });

  test("should refuse an image above the pixel limit and name the fix", async () => {
    const dir = await createTempDir();
    await writeFile(join(dir, "huge.png"), pngHeader(6000, 6000));

    await expect(readImage(dir, "huge.png")).rejects.toThrow(
      /6000x6000 px exceeds the 20000000-pixel limit/u
    );
  });

  test("should refuse bytes above the size limit before reading them", async () => {
    const dir = await createTempDir();
    const oversized = Buffer.concat([
      pngHeader(10, 10),
      Buffer.alloc(2 * 1024 * 1024),
    ]);
    await writeFile(join(dir, "big.png"), oversized);

    await expect(readImage(dir, "big.png")).rejects.toThrow(
      /exceeds the 2\.0 MB limit/u
    );
  });

  test("should say that offset and limit do not page an image", async () => {
    const dir = await createTempDir();
    await writeFile(join(dir, "red.png"), PNG_1X1);

    const paged = await readImage(dir, "red.png");
    expect(paged.output).not.toContain("apply to text files only");

    const tool = imageTool(dir, ["text", "image"]);
    const execute = tool.execute as unknown as (
      input: { path: string; offset: number },
      options: unknown
    ) => Promise<{ output: string }>;
    const result = await execute(
      { path: "red.png", offset: 2 },
      { toolCallId: "call-1", messages: [] }
    );
    expect(result.output).toContain(
      "offset and limit apply to text files only"
    );
  });

  test("should give the model the envelope and the image together", async () => {
    const dir = await createTempDir();
    await writeFile(join(dir, "red.png"), PNG_1X1);

    const tool = imageTool(dir, ["text", "image"]);
    const execute = tool.execute as unknown as (
      input: { path: string },
      options: unknown
    ) => Promise<Record<string, unknown>>;
    const output = await execute(
      { path: "red.png" },
      { toolCallId: "call-1", messages: [] }
    );
    const toModelOutput = tool.toModelOutput as unknown as (input: {
      output: Record<string, unknown>;
    }) => Promise<{
      type: string;
      value: { type: string; text?: string; mediaType?: string }[];
    }>;

    const model = await toModelOutput({ output });

    expect(model.type).toBe("content");
    expect(model.value.map((part) => part.type)).toStrictEqual([
      "text",
      "file",
    ]);
    expect(model.value[1]?.mediaType).toBe("image/png");
  });

  test("should keep a PDF as an attachment without a size", async () => {
    const dir = await createTempDir();
    const pdf = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n", "ascii");
    await writeFile(join(dir, "doc.pdf"), pdf);

    const result = await readImage(dir, "doc.pdf", ["text", "image", "pdf"]);
    const attachments = result.attachments as Record<string, unknown>[];

    expect(result.output).toContain("<type>file</type>");
    expect(result.output).toContain("application/pdf");
    expect(attachments[0]).not.toHaveProperty("width");
  });
});
