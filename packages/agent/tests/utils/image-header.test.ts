import { describe, expect, test } from "vitest";

import { imageDimensions } from "../../src/utils/image-header";

function bytes(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

/** A one-pixel PNG whose IHDR declares the given size. */
function png(width: number, height: number): Uint8Array {
  return bytes(
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    0,
    0,
    0,
    13,
    0x49,
    0x48,
    0x44,
    0x52,
    (width >>> 24) & 0xff,
    (width >>> 16) & 0xff,
    (width >>> 8) & 0xff,
    width & 0xff,
    (height >>> 24) & 0xff,
    (height >>> 16) & 0xff,
    (height >>> 8) & 0xff,
    height & 0xff,
    8,
    2,
    0,
    0,
    0
  );
}

function gif(width: number, height: number): Uint8Array {
  return bytes(
    0x47,
    0x49,
    0x46,
    0x38,
    0x39,
    0x61,
    width & 0xff,
    (width >>> 8) & 0xff,
    height & 0xff,
    (height >>> 8) & 0xff,
    0,
    0,
    0
  );
}

function jpeg(width: number, height: number): Uint8Array {
  // SOI, an empty APP0 segment, then SOF0 with an 8-bit sample.
  const header = [
    0xff,
    0xd8,
    0xff,
    0xe0,
    0,
    4,
    0,
    0,
    0xff,
    0xc0,
    0,
    17,
    8,
    (height >>> 8) & 0xff,
    height & 0xff,
    (width >>> 8) & 0xff,
    width & 0xff,
    3,
    1,
    0x22,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1,
  ];
  return bytes(...header);
}

function webpLossless(width: number, height: number): Uint8Array {
  const packed = (width - 1) | ((height - 1) << 14);
  return bytes(
    0x52,
    0x49,
    0x46,
    0x46,
    0,
    0,
    0,
    0,
    0x57,
    0x45,
    0x42,
    0x50,
    0x56,
    0x50,
    0x38,
    0x4c,
    4,
    0,
    0,
    0,
    0x2f,
    packed & 0xff,
    (packed >>> 8) & 0xff,
    (packed >>> 16) & 0xff,
    (packed >>> 24) & 0xff,
    0,
    0,
    0,
    0,
    0
  );
}

function webpExtended(width: number, height: number): Uint8Array {
  const w = width - 1;
  const h = height - 1;
  return bytes(
    0x52,
    0x49,
    0x46,
    0x46,
    0,
    0,
    0,
    0,
    0x57,
    0x45,
    0x42,
    0x50,
    0x56,
    0x50,
    0x38,
    0x58,
    10,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    w & 0xff,
    (w >>> 8) & 0xff,
    (w >>> 16) & 0xff,
    h & 0xff,
    (h >>> 8) & 0xff,
    (h >>> 16) & 0xff
  );
}

describe(imageDimensions, () => {
  test("should read the size of each supported container", () => {
    expect(imageDimensions(png(1920, 1080))).toStrictEqual({
      width: 1920,
      height: 1080,
    });
    expect(imageDimensions(gif(320, 240))).toStrictEqual({
      width: 320,
      height: 240,
    });
    expect(imageDimensions(jpeg(4032, 3024))).toStrictEqual({
      width: 4032,
      height: 3024,
    });
    expect(imageDimensions(webpLossless(800, 600))).toStrictEqual({
      width: 800,
      height: 600,
    });
    expect(imageDimensions(webpExtended(2560, 1440))).toStrictEqual({
      width: 2560,
      height: 1440,
    });
  });

  test("should decline bytes it does not recognise instead of guessing", () => {
    expect(imageDimensions(bytes())).toBeUndefined();
    expect(imageDimensions(bytes(0x89, 0x50, 0x4e, 0x47))).toBeUndefined();
    expect(imageDimensions(bytes(0x25, 0x50, 0x44, 0x46))).toBeUndefined();
    // A RIFF container that is not WebP.
    expect(
      imageDimensions(
        bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45)
      )
    ).toBeUndefined();
  });
});
