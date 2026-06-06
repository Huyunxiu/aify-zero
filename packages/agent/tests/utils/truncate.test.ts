import { test, describe, expect, beforeEach, vi } from "vitest";

import { Truncate } from "../../src/utils/truncate.js";
import type { TruncateOptions } from "../../src/utils/truncate.js";

vi.mock(import("node:fs/promises"));

const defaultOptions: TruncateOptions = {
  dir: "/tmp/test-truncate",
};

describe(Truncate, () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  describe("constructor", () => {
    test("should use default values when not provided", () => {
      const t = new Truncate(defaultOptions);
      const limits = t.limits();
      expect(limits.maxLines).toBe(2000);
      expect(limits.maxBytes).toBe(50 * 1024);
    });

    test("should accept custom values", () => {
      const t = new Truncate({
        dir: "/tmp/custom",
        direction: "tail",
        hasTaskTool: true,
        maxBytes: 1024,
        maxLines: 100,
      });
      // limits() returns default constants, not instance values
      // so we verify custom values via output() behavior instead
      expect(t.limits()).toStrictEqual({ maxBytes: 51_200, maxLines: 2000 });
    });
  });

  describe("limits", () => {
    test("should return default constants when no args given", () => {
      const t = new Truncate(defaultOptions);
      const limits = t.limits();
      expect(limits).toStrictEqual({ maxBytes: 51_200, maxLines: 2000 });
    });

    test("should override with provided args", () => {
      const t = new Truncate(defaultOptions);
      const limits = t.limits(10, 500);
      expect(limits).toStrictEqual({ maxBytes: 500, maxLines: 10 });
    });
  });

  describe("write", () => {
    test("should write content to a file and return the path", async () => {
      const { mkdir, writeFile } = await import("node:fs/promises");
      const t = new Truncate({ dir: "/tmp/out" });
      const filePath = await t.write("myfile", "hello world");

      expect(filePath).toBe("/tmp/out/myfile.txt");
      expect(mkdir).toHaveBeenCalledWith("/tmp/out", { recursive: true });
      expect(writeFile).toHaveBeenCalledWith(filePath, "hello world", "utf-8");
    });
  });

  describe("output", () => {
    test("should return content unchanged when within limits", async () => {
      const t = new Truncate({ dir: "/tmp", maxBytes: 1024, maxLines: 10 });
      const result = await t.output("hello\nworld");

      expect(result).toStrictEqual({
        content: "hello\nworld",
        truncated: false,
      });
    });

    test("should truncate when exceeding maxLines (direction=head)", async () => {
      const t = new Truncate({ dir: "/tmp", maxBytes: 999_999, maxLines: 3 });
      const text = "a\nb\nc\nd\ne";
      const result = await t.output(text);

      expect(result.truncated).toBeTruthy();
      expect(result.content).toContain("a\nb\nc");
      expect(result.content).toContain("...2 lines truncated...");
      if (result.truncated) {
        // oxlint-disable-next-line vitest/no-conditional-expect
        expect(result.outputPath).toBeDefined();
      }
    });

    test("should truncate when exceeding maxBytes (direction=head)", async () => {
      const t = new Truncate({
        dir: "/tmp",
        maxBytes: 8,
        maxLines: 999,
      });
      // Single line "1234567890" is 10 bytes > maxBytes=8
      const text = "1234567890";
      const result = await t.output(text);

      expect(result.truncated).toBeTruthy();
      expect(result.content).toContain("...10 bytes truncated...");
    });

    test("should truncate from tail when direction=tail", async () => {
      const t = new Truncate({
        dir: "/tmp",
        direction: "tail",
        maxBytes: 999_999,
        maxLines: 2,
      });
      const text = "a\nb\nc\nd";
      const result = await t.output(text);

      expect(result.truncated).toBeTruthy();
      expect(result.content).toContain("c\nd");
      expect(result.content).toContain("...2 lines truncated...");
      // truncation notice comes BEFORE content in tail mode
      expect(result.content.indexOf("...2 lines truncated...")).toBeLessThan(
        result.content.indexOf("c\nd")
      );
    });

    test("should use Task tool hint when hasTaskTool is true", async () => {
      const t = new Truncate({
        dir: "/tmp",
        hasTaskTool: true,
        maxBytes: 999_999,
        maxLines: 1,
      });
      const result = await t.output("a\nb\nc");

      expect(result.truncated).toBeTruthy();
      expect(result.content).toContain("Use the Task tool");
      expect(result.content).not.toContain("Use Grep to search");
    });

    test("should use Grep/Read hint when hasTaskTool is false", async () => {
      const t = new Truncate({
        dir: "/tmp",
        hasTaskTool: false,
        maxBytes: 999_999,
        maxLines: 1,
      });
      const result = await t.output("a\nb\nc");

      expect(result.truncated).toBeTruthy();
      expect(result.content).toContain("Use Grep to search");
      expect(result.content).not.toContain("Use the Task tool");
    });

    test("should prioritize byte limit over line limit", async () => {
      const t = new Truncate({
        dir: "/tmp",
        maxBytes: 5,
        maxLines: 100,
      });
      // A single line of 100 bytes
      const text = "x".repeat(100);
      const result = await t.output(text);

      expect(result.truncated).toBeTruthy();
      expect(result.content).toContain("bytes truncated");
    });

    test("should handle empty string", async () => {
      const t = new Truncate({ dir: "/tmp", maxBytes: 1024, maxLines: 10 });
      const result = await t.output("");

      expect(result).toStrictEqual({ content: "", truncated: false });
    });

    test("should handle single line within limits", async () => {
      const t = new Truncate({ dir: "/tmp", maxBytes: 1024, maxLines: 1 });
      const result = await t.output("hello");

      expect(result).toStrictEqual({ content: "hello", truncated: false });
    });

    test("should call write with the full original text", async () => {
      const writeSpy = vi.spyOn(Truncate.prototype, "write");
      const t = new Truncate({ dir: "/tmp", maxBytes: 999_999, maxLines: 1 });
      await t.output("full\ntext");

      expect(writeSpy).toHaveBeenCalledWith(expect.any(String), "full\ntext");
      writeSpy.mockRestore();
    });
  });

  describe("cleanup", () => {
    test("should delete expired tool files", async () => {
      const { readdir, rm } = await import("node:fs/promises");
      // 10 days ago
      const oldTs = Date.now() - 10 * 24 * 60 * 60 * 1000;
      const currentTs = Date.now();
      vi.mocked(readdir).mockResolvedValue([
        `tool_${oldTs}_abc` as any,
        `tool_${currentTs}_xyz` as any,
        "not-tool-file" as any,
      ] as const);

      const t = new Truncate({ dir: "/tmp/cleanup" });
      await t.cleanup();

      // Only delete files older than retention period (7 days = 604800000ms)
      expect(rm).toHaveBeenCalledExactlyOnceWith(
        `/tmp/cleanup/tool_${oldTs}_abc`,
        {
          force: true,
        }
      );
      expect(rm).toHaveBeenCalledOnce();
    });

    test("should do nothing if directory does not exist", async () => {
      const { readdir, rm } = await import("node:fs/promises");
      vi.mocked(readdir).mockRejectedValue(new Error("ENOENT"));

      const t = new Truncate({ dir: "/tmp/nonexistent" });
      await expect(t.cleanup()).resolves.toBeUndefined();
      expect(rm).not.toHaveBeenCalled();
    });
  });
});
