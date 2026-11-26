import { describe, expect, test } from "vitest";

import {
  DECODE_MAX_BYTES,
  ImageDecodeError,
  loadImageDecoder,
  NORMALIZED_MAX_BYTES,
  NORMALIZED_MAX_EDGE,
  NORMALIZED_MAX_PIXELS,
  normalizeImage,
  normalizedTargetSize,
} from "../../src/attachments/normalize";

const decoder = await loadImageDecoder();

/** Build a solid-colour image in the requested format, through the decoder itself. */
async function fixture(
  width: number,
  height: number,
  options: {
    format?: "jpeg" | "png";
    alpha?: boolean;
    orientation?: number;
  } = {}
): Promise<Buffer> {
  if (decoder === undefined) {
    throw new Error("the decoder is required to build a fixture");
  }
  let pipeline = decoder({
    create: {
      width,
      height,
      channels: options.alpha === true ? 4 : 3,
      background:
        options.alpha === true ? { r: 1, g: 2, b: 3, alpha: 0.5 } : "#808080",
    },
  });
  if (options.orientation !== undefined) {
    pipeline = pipeline.withMetadata({ orientation: options.orientation });
  }
  return options.format === "jpeg"
    ? await pipeline.jpeg().toBuffer()
    : await pipeline.png().toBuffer();
}

describe(normalizedTargetSize, () => {
  test("should leave an image inside both budgets alone", () => {
    expect(normalizedTargetSize(800, 600)).toStrictEqual({
      width: 800,
      height: 600,
    });
  });

  test("should cap the pixel budget for a photo and keep the aspect ratio", () => {
    // 4032x3024 is 12.2 MP; the pixel budget binds before the long-edge cap does.
    expect(normalizedTargetSize(4032, 3024)).toStrictEqual({
      width: 1239,
      height: 929,
    });
  });

  test("should cap the pixel budget for a square image", () => {
    const size = normalizedTargetSize(3000, 3000);

    expect(size.width * size.height).toBeLessThanOrEqual(NORMALIZED_MAX_PIXELS);
    expect(size.width).toBe(size.height);
  });

  test("should keep an extreme aspect ratio at least one pixel tall", () => {
    const size = normalizedTargetSize(10_000, 10);

    expect(size.width).toBe(NORMALIZED_MAX_EDGE);
    expect(size.height).toBeGreaterThanOrEqual(1);
  });
});

describe(normalizeImage, () => {
  test("should store a photo as a bounded WebP", async () => {
    const source = await fixture(4032, 3024, { format: "jpeg" });

    const normalized = await normalizeImage(source);

    expect(normalized.mediaType).toBe("image/webp");
    expect(normalized.width).toBe(1239);
    expect(normalized.height).toBe(929);
    expect(normalized.data.byteLength).toBeLessThanOrEqual(
      NORMALIZED_MAX_BYTES
    );
  });

  test("should name the source size it reduced", async () => {
    const source = await fixture(4032, 3024, { format: "jpeg" });

    const normalized = await normalizeImage(source);

    expect(normalized.originalDimensions).toStrictEqual({
      width: 4032,
      height: 3024,
    });
    expect(normalized.width * normalized.height).toBeLessThanOrEqual(
      NORMALIZED_MAX_PIXELS
    );
  });

  test("should apply the orientation the model cannot see", async () => {
    const source = await fixture(100, 50, { orientation: 6 });

    const normalized = await normalizeImage(source);

    expect(normalized.width).toBe(50);
    expect(normalized.height).toBe(100);
  });

  test("should keep transparency", async () => {
    const source = await fixture(4, 4, { alpha: true });

    const normalized = await normalizeImage(source);

    /* v8 ignore next -- the decoder exists whenever this test runs. */
    const metadata = await decoder!(normalized.data).metadata();
    expect(metadata.hasAlpha).toBeTruthy();
    expect(normalized.width).toBe(4);
  });

  test("should refuse bytes it cannot decode, with the reason", async () => {
    const pdf = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n", "ascii");

    await expect(normalizeImage(pdf)).rejects.toThrow(ImageDecodeError);
  });

  test("should refuse a file above the decode limit before loading it", async () => {
    const oversized = Buffer.alloc(DECODE_MAX_BYTES + 1);

    await expect(normalizeImage(oversized)).rejects.toThrow(/decode limit/u);
  });
});
