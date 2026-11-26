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

  /** A 200x100 image: red on the left half, blue on the right half. */
  async function twoColours(): Promise<Buffer> {
    /* v8 ignore next -- the suite cannot run without a decoder. */
    if (decoder === undefined) {
      throw new Error("the decoder is required to build this fixture");
    }
    const red = await decoder({
      create: { width: 200, height: 100, channels: 3, background: "#ff0000" },
    })
      .png()
      .toBuffer();
    const blue = await decoder({
      create: { width: 100, height: 100, channels: 3, background: "#0000ff" },
    })
      .png()
      .toBuffer();
    return await decoder(red)
      .composite([{ input: blue, left: 100, top: 0 }])
      .png()
      .toBuffer();
  }

  test("should keep only the named fraction of the image", async () => {
    const source = await twoColours();

    const normalized = await normalizeImage(source, {
      region: { x: 0.5, y: 0, width: 0.5, height: 1 },
    });

    const { data } = await decoder!(normalized.data)
      .raw()
      .toBuffer({ resolveWithObject: true });

    expect(normalized.cropBox).toStrictEqual({
      left: 100,
      top: 0,
      width: 100,
      height: 100,
    });
    expect(normalized.region).toStrictEqual({
      x: 0.5,
      y: 0,
      width: 0.5,
      height: 1,
    });
    expect(normalized.originalDimensions).toStrictEqual({
      width: 200,
      height: 100,
    });
    // The right half is blue, so the crop must not show the red that surrounds it.
    expect([data[0], data[1], data[2]]).toStrictEqual([0, 0, 255]);
  });

  test("should crop at source resolution before it reduces", async () => {
    // A quarter of a 2000x2000 image is 1000x1000, which is inside the pixel budget,
    // so the delivered copy keeps the region at its own resolution.
    const source = await fixture(2000, 2000);

    const normalized = await normalizeImage(source, {
      region: { x: 0, y: 0, width: 0.5, height: 0.5 },
    });

    expect(normalized.width).toBe(1000);
    expect(normalized.height).toBe(1000);
    expect(normalized.cropBox?.left).toBe(0);
  });

  test("should apply the region in the space the orientation produces", async () => {
    /* v8 ignore next -- the suite cannot run without a decoder. */
    if (decoder === undefined) {
      throw new Error("the decoder is required to build this fixture");
    }
    const red = await decoder({
      create: { width: 200, height: 100, channels: 3, background: "#ff0000" },
    })
      .png()
      .toBuffer();
    const blue = await decoder({
      create: { width: 100, height: 100, channels: 3, background: "#0000ff" },
    })
      .png()
      .toBuffer();
    const source = await decoder(red)
      .composite([{ input: blue, left: 100, top: 0 }])
      .withMetadata({ orientation: 6 })
      .png()
      .toBuffer();

    // Orientation 6 shows the stored left half on top, so the bottom half is blue.
    const normalized = await normalizeImage(source, {
      region: { x: 0, y: 0.5, width: 1, height: 0.5 },
    });

    const { data } = await decoder(Buffer.from(normalized.data))
      .raw()
      .toBuffer({ resolveWithObject: true });

    expect(normalized.originalDimensions).toStrictEqual({
      width: 100,
      height: 200,
    });
    expect(normalized.cropBox).toStrictEqual({
      left: 0,
      top: 100,
      width: 100,
      height: 100,
    });
    expect([data[0], data[1], data[2]]).toStrictEqual([0, 0, 255]);
  });

  test("should still reduce a crop that is over the budget", async () => {
    // Half of a 4000x4000 image is 2000x2000: 4 MP, above the 1.15 MP budget.
    const source = await fixture(4000, 4000);

    const normalized = await normalizeImage(source, {
      region: { x: 0, y: 0, width: 0.5, height: 0.5 },
    });

    expect(normalized.cropBox).toStrictEqual({
      left: 0,
      top: 0,
      width: 2000,
      height: 2000,
    });
    expect(normalized.width).toBeLessThan(2000);
    expect(normalized.width * normalized.height).toBeLessThanOrEqual(
      NORMALIZED_MAX_PIXELS
    );
  });
});
