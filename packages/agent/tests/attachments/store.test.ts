import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  attachmentPath,
  readAttachment,
  saveAttachment,
} from "../../src/attachments/store";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "aify-attachment-"));
  tempDirs.push(dir);
  return dir;
}

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("attachment store", () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
    );
  });

  test("should name the object by its digest and store the bytes once", async () => {
    const dir = await createTempDir();

    const first = await saveAttachment({
      sessionDir: dir,
      owner: "session:s1",
      data: PNG,
      mediaType: "image/png",
      width: 1,
      height: 1,
      name: "/tmp/red.png",
    });
    const second = await saveAttachment({
      sessionDir: dir,
      owner: "session:s1",
      data: PNG,
      mediaType: "image/png",
    });

    const stored = await readFile(attachmentPath(dir, first.sha256));
    expect(first.sha256).toBe(second.sha256);
    expect(stored.byteLength).toBe(PNG.byteLength);
    expect(first).toMatchObject({
      type: "attachment",
      owner: "session:s1",
      mediaType: "image/png",
      bytes: PNG.byteLength,
      width: 1,
      height: 1,
      name: "/tmp/red.png",
    });
  });

  test("should store one object for the same bytes", async () => {
    const dir = await createTempDir();
    const first = await saveAttachment({
      sessionDir: dir,
      owner: "session:s1",
      data: PNG,
      mediaType: "image/png",
    });
    await saveAttachment({
      sessionDir: dir,
      owner: "session:s1",
      data: PNG,
      mediaType: "image/png",
    });

    const stored = await readdir(join(dir, "attachments"));

    expect(stored).toStrictEqual([first.sha256]);
  });

  test("should return the stored bytes", async () => {
    const dir = await createTempDir();
    const ref = await saveAttachment({
      sessionDir: dir,
      owner: "session:s1",
      data: PNG,
      mediaType: "image/png",
    });

    await expect(readAttachment(dir, ref)).resolves.toStrictEqual(PNG);
  });

  test("should refuse bytes that do not hash to their name", async () => {
    const dir = await createTempDir();
    const ref = await saveAttachment({
      sessionDir: dir,
      owner: "session:s1",
      data: PNG,
      mediaType: "image/png",
    });
    await writeFile(attachmentPath(dir, ref.sha256), "tampered");

    await expect(readAttachment(dir, ref)).rejects.toThrow(
      /does not match its stored bytes/u
    );
  });

  test("should refuse a reference whose name is not a digest", async () => {
    const dir = await createTempDir();

    await expect(
      readAttachment(dir, {
        type: "attachment",
        sha256: "../escape",
        owner: "session:s1",
        mediaType: "image/png",
        bytes: 1,
      })
    ).rejects.toThrow(/is not a digest/u);
  });
});
