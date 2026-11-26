/**
 * The header-only path: a deployment whose native image decoder is missing.
 *
 * The read must still work. It knows the size from the file header, it still refuses
 * an image above the pixel limit, and it stores the source bytes unchanged. This file
 * mocks the decoder module, because the real one exists wherever the suite runs.
 */
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import type { AgentContext } from "../../src/agent-context";
import { createReadFileTool } from "../../src/tools/read-file";
import { testSandbox } from "../helpers/sandbox.js";

// The real decoder exists wherever the suite runs, so the module is replaced with a
// copy whose loader reports that this deployment has none.
vi.mock(import("../../src/attachments/normalize"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    loadImageDecoder: () => Promise.resolve(),
  } as typeof actual;
});

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "aify-read-file-nod-"));
  tempDirs.push(dir);
  return dir;
}

/** A PNG header that declares a size, without any pixels behind it. */
function pngHeader(width: number, height: number): Buffer {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12, "ascii");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  header.set([8, 2, 0, 0, 0], 24);
  return header;
}

async function read(dir: string, path: string) {
  const agentContext = {
    sessionId: "session-1",
    projectDirs: [dir],
    primaryProjectDir: dir,
    sessionDir: dir,
    inputKinds: ["text", "image"],
    sandbox: testSandbox(dir),
  } as unknown as AgentContext;
  const tool = createReadFileTool({ agentContext });
  const execute = tool.execute as unknown as (
    input: { path: string },
    options: unknown
  ) => Promise<Record<string, unknown>>;

  return await execute({ path }, { toolCallId: "call-1", messages: [] });
}

describe("read-file without an image decoder", () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
    );
  });

  test("should keep the source bytes and report the header size", async () => {
    const dir = await createTempDir();
    const source = pngHeader(40, 20);
    await writeFile(join(dir, "small.png"), source);

    const result = await read(dir, "small.png");
    const [attachment] = result.attachments as {
      mediaType: string;
      width: number;
      height: number;
      bytes: number;
    }[];

    expect(result.output).toContain("image/png, 40x20 px");
    expect(attachment).toMatchObject({
      mediaType: "image/png",
      width: 40,
      height: 20,
      bytes: source.byteLength,
    });
  });

  test("should still refuse an image above the pixel limit", async () => {
    const dir = await createTempDir();
    await writeFile(join(dir, "huge.png"), pngHeader(6000, 6000));

    await expect(read(dir, "huge.png")).rejects.toThrow(
      /6000x6000 px exceeds the 20000000-pixel limit/u
    );
    await expect(readdir(join(dir, "attachments"))).rejects.toThrow(/ENOENT/u);
  });

  test("should refuse a format whose size its header cannot declare", async () => {
    const dir = await createTempDir();
    // A little-endian TIFF signature: the header reader knows PNG, JPEG, GIF, and
    // WebP only, and this deployment has no decoder to measure anything else.
    await writeFile(
      join(dir, "scan.tiff"),
      Buffer.from([0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0, 0, 0, 0, 0])
    );

    await expect(read(dir, "scan.tiff")).rejects.toThrow(
      /needs the image decoder/u
    );
  });

  test("should refuse a region instead of reading the whole image", async () => {
    const dir = await createTempDir();
    await writeFile(join(dir, "small.png"), pngHeader(40, 20));

    const tool = (() => {
      const agentContext = {
        sessionId: "session-1",
        projectDirs: [dir],
        primaryProjectDir: dir,
        sessionDir: dir,
        inputKinds: ["text", "image"],
        sandbox: testSandbox(dir),
      } as unknown as AgentContext;
      return createReadFileTool({ agentContext });
    })();
    const execute = tool.execute as unknown as (
      input: {
        path: string;
        region: { x: number; y: number; width: number; height: number };
      },
      options: unknown
    ) => Promise<unknown>;

    await expect(
      execute(
        { path: "small.png", region: { x: 0, y: 0, width: 0.5, height: 0.5 } },
        { toolCallId: "call-1", messages: [] }
      )
    ).rejects.toThrow(/a region needs the image decoder/u);
  });
});
