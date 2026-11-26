/**
 * Image normalization: decode a photo once, and store a bounded copy.
 *
 * A read cannot hand the model whatever the file is. A phone photo is megabytes of
 * pixels the route will downscale anyway, an EXIF orientation is a rotation the model
 * cannot see, and a colour profile is bytes that only make the payload larger. This
 * module decodes the image and produces the one form the harness stores: a single
 * frame, 8-bit, sRGB, no metadata, inside a fixed pixel and byte budget.
 *
 * The decoder is loaded on demand. A deployment whose native binary is missing keeps
 * the header-only path: dimensions are still known, an oversized image is still
 * refused, and the tool still works.
 *
 * @module
 */

import type sharp from "sharp";

/** The largest encoded input this module decodes, as a decompression-bomb guard. */
export const DECODE_MAX_BYTES = 64 * 1024 * 1024;

/** The largest decoded input this module decodes, as a decompression-bomb guard. */
export const DECODE_MAX_PIXELS = 100_000_000;

/** The longest edge of a normalized image. */
export const NORMALIZED_MAX_EDGE = 1568;

/** The largest normalized image, in pixels; providers charge more above it. */
export const NORMALIZED_MAX_PIXELS = 1_152_000;

/** The largest normalized image, in bytes. */
export const NORMALIZED_MAX_BYTES = 1024 * 1024;

/** A decoded image in the one form the harness stores. */
export interface NormalizedImage {
  readonly data: Uint8Array;
  /** Always `image/webp`: one format keeps the store and the route predictable. */
  readonly mediaType: string;
  readonly width: number;
  readonly height: number;
  /** Orientation-applied source size, present only when normalization reduced it. */
  readonly originalDimensions?: {
    readonly width: number;
    readonly height: number;
  };
}

/** An image this module cannot decode, with the sentence that names the fix. */
export class ImageDecodeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ImageDecodeError";
  }
}

/** The callable sharp factory; the package exposes it as its default export. */
type SharpFactory = typeof sharp;
type SharpPipeline = ReturnType<SharpFactory>;

let decoder: Promise<SharpFactory | undefined> | undefined;

/**
 * Load the native decoder once per process.
 *
 * A missing or broken binary is a deployment fact, not a crash: the caller falls back
 * to the header-only path.
 * @returns the decoder, or undefined when this deployment has none.
 */
export function loadImageDecoder(): Promise<SharpFactory | undefined> {
  const loaded = decoder;
  if (loaded !== undefined) {
    return loaded;
  }
  const started = loadSharpOrUndefined();
  decoder = started;
  return started;
}

/** Import the native module once; a missing or broken binary yields undefined. */
async function loadSharpOrUndefined(): Promise<SharpFactory | undefined> {
  try {
    const module = await import("sharp");
    return (
      (module as { default?: SharpFactory }).default ??
      (module as unknown as SharpFactory)
    );
  } catch {
    return undefined;
  }
}

/** Quality ladder for a lossy encode; the first result inside the byte budget wins. */
const LOSSY_QUALITIES = [82, 70, 58];

/**
 * How many times the pipeline may halve the edge.
 *
 * Each attempt shrinks the encoded result, so a normal photo clears the budget on the
 * first or second pass. The bound exists to stop a pathological image from looping, not
 * to give up on the budget: an image still over it is refused below.
 */
const RESIZE_ATTEMPTS = 6;

/** One decoder pipeline over the source, before a target size is chosen. */
function decodePipeline(sharp: SharpFactory, data: Uint8Array): SharpPipeline {
  return sharp(data, { failOn: "error", limitInputPixels: DECODE_MAX_PIXELS });
}

/** The width and height an image should have, inside both budgets and never enlarged. */
export function normalizedTargetSize(
  width: number,
  height: number
): { width: number; height: number } {
  if (width <= 0 || height <= 0) {
    throw new ImageDecodeError("the image declares an empty size");
  }
  const pixels = width * height;
  const scale = Math.min(
    1,
    NORMALIZED_MAX_EDGE / Math.max(width, height),
    Math.sqrt(NORMALIZED_MAX_PIXELS / pixels)
  );
  if (scale === 1) {
    return { width, height };
  }
  const scaledWidth = Math.max(1, Math.floor(width * scale));
  const scaledHeight = Math.max(1, Math.round((scaledWidth * height) / width));
  return { width: scaledWidth, height: scaledHeight };
}

/** One encode attempt at a given size and quality. */
async function encode(
  pipeline: SharpPipeline,
  quality: number | "lossless"
): Promise<Buffer> {
  return quality === "lossless"
    ? await pipeline.webp({ lossless: true, effort: 4 }).toBuffer()
    : await pipeline.webp({ quality, effort: 4 }).toBuffer();
}

/**
 * Normalize one image.
 *
 * The pipeline always re-encodes, even when the source is already small: one stored
 * form is worth more than the CPU a pass-through would save, because a PNG screenshot
 * and a JPEG photo then cost the same to replay and to render.
 * @param data - the encoded source bytes.
 * @returns the stored bytes and the facts the reference records.
 * @throws ImageDecodeError when the bytes cannot be decoded inside the guards.
 */
export async function normalizeImage(
  data: Uint8Array
): Promise<NormalizedImage> {
  if (data.byteLength > DECODE_MAX_BYTES) {
    throw new ImageDecodeError(
      `the file is larger than the ${DECODE_MAX_BYTES / (1024 * 1024)} MB decode limit`
    );
  }

  const sharp = await loadImageDecoder();
  if (sharp === undefined) {
    throw new ImageDecodeError("this deployment has no image decoder");
  }

  const source = decodePipeline(sharp, data);

  let metadata;
  try {
    metadata = await source.metadata();
  } catch (error) {
    throw new ImageDecodeError(
      "the bytes do not decode as an image; the file may be truncated or corrupt",
      { cause: error }
    );
  }

  const storedWidth = metadata.width;
  const storedHeight = metadata.height;
  if (storedWidth === undefined || storedHeight === undefined) {
    throw new ImageDecodeError("the image header does not declare a size");
  }
  // EXIF orientations 5 to 8 transpose the stored raster, and `.rotate()` below
  // applies them, so the source size the reference reports must be transposed too.
  const transposed =
    metadata.orientation !== undefined && metadata.orientation >= 5;
  const originalWidth = transposed ? storedHeight : storedWidth;
  const originalHeight = transposed ? storedWidth : storedHeight;
  if (originalWidth * originalHeight > DECODE_MAX_PIXELS) {
    throw new ImageDecodeError(
      `the image is ${originalWidth}x${originalHeight} px, above the ${DECODE_MAX_PIXELS}-pixel decode limit`
    );
  }

  const target = normalizedTargetSize(originalWidth, originalHeight);
  const keepAlpha = metadata.hasAlpha;
  const qualities: (number | "lossless")[] = keepAlpha
    ? ["lossless"]
    : LOSSY_QUALITIES;

  let smallest: Buffer | undefined;
  let { width } = target;
  let { height } = target;

  for (let attempt = 0; attempt < RESIZE_ATTEMPTS; attempt += 1) {
    for (const quality of qualities) {
      const resized = decodePipeline(sharp, data)
        .rotate()
        .toColourspace("srgb")
        .resize({ width, height, fit: "inside", withoutEnlargement: true });
      let encoded: Buffer;
      try {
        encoded = await encode(resized, quality);
      } catch (error) {
        throw new ImageDecodeError(
          "the image could not be written as an 8-bit sRGB WebP; convert it to PNG or JPEG first",
          { cause: error }
        );
      }
      if (smallest === undefined || encoded.byteLength < smallest.byteLength) {
        smallest = encoded;
      }
      if (encoded.byteLength <= NORMALIZED_MAX_BYTES) {
        return await finish(encoded, originalWidth, originalHeight);
      }
    }
    width = Math.max(1, Math.floor(width / 2));
    height = Math.max(1, Math.floor(height / 2));
  }

  /* v8 ignore next -- the ladder always produces bytes on its first attempt. */
  if (smallest === undefined) {
    throw new ImageDecodeError("the image produced no output");
  }
  if (smallest.byteLength > NORMALIZED_MAX_BYTES) {
    throw new ImageDecodeError(
      `the image cannot be stored within the ${NORMALIZED_MAX_BYTES / 1024} KB budget; crop it, then read the smaller copy`
    );
  }
  return await finish(smallest, originalWidth, originalHeight);
}

/** Verify the encoded result and describe it. */
async function finish(
  encoded: Buffer,
  originalWidth: number,
  originalHeight: number
): Promise<NormalizedImage> {
  const sharp = await loadImageDecoder();
  /* v8 ignore next -- finish runs only after a successful encode, which needs the decoder. */
  if (sharp === undefined) {
    throw new ImageDecodeError("this deployment has no image decoder");
  }
  const output = await sharp(encoded).metadata();
  const width = output.width ?? 0;
  const height = output.height ?? 0;
  if (
    output.format !== "webp" ||
    width <= 0 ||
    height <= 0 ||
    output.depth !== "uchar"
  ) {
    throw new ImageDecodeError(
      "image normalization did not produce a single-frame 8-bit WebP"
    );
  }
  const downscaled = width !== originalWidth || height !== originalHeight;

  return {
    data: new Uint8Array(encoded),
    mediaType: "image/webp",
    width,
    height,
    ...(downscaled
      ? { originalDimensions: { width: originalWidth, height: originalHeight } }
      : {}),
  };
}
