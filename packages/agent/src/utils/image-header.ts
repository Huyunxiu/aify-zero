/**
 * Intrinsic image dimensions read from a file header.
 *
 * The dimensions feed the pixel limit enforced before a read and the envelope the
 * model reads. Neither needs pixels, so this module never decodes an image: it reads
 * the few header bytes that carry the size, and returns undefined for anything it does
 * not recognise.
 *
 * @module
 */

/** Dimensions declared by a supported image header. */
export interface ImageDimensions {
  readonly width: number;
  readonly height: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** Baseline and progressive JPEG start-of-frame markers; the rest carry no size. */
const JPEG_FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function u16be(data: Uint8Array, offset: number): number {
  return (data[offset] ?? 0) * 0x1_00 + (data[offset + 1] ?? 0);
}

function u16le(data: Uint8Array, offset: number): number {
  return (data[offset] ?? 0) + (data[offset + 1] ?? 0) * 0x1_00;
}

function u24le(data: Uint8Array, offset: number): number {
  return (
    (data[offset] ?? 0) +
    (data[offset + 1] ?? 0) * 0x1_00 +
    (data[offset + 2] ?? 0) * 0x1_00_00
  );
}

function u32le(data: Uint8Array, offset: number): number {
  return (
    (data[offset] ?? 0) +
    (data[offset + 1] ?? 0) * 0x1_00 +
    (data[offset + 2] ?? 0) * 0x1_00_00 +
    (data[offset + 3] ?? 0) * 0x1_00_00_00
  );
}

function ascii(data: Uint8Array, offset: number, text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (data[offset + index] !== text.codePointAt(index)) {
      return false;
    }
  }
  return true;
}

function pngSize(data: Uint8Array): ImageDimensions | undefined {
  if (data.length < 24) {
    return undefined;
  }
  for (const [index, byte] of PNG_SIGNATURE.entries()) {
    if (data[index] !== byte) {
      return undefined;
    }
  }
  // The IHDR chunk is required to come first: length, type, width, height.
  if (!ascii(data, 12, "IHDR")) {
    return undefined;
  }
  return {
    width: u16be(data, 16) * 0x1_00_00 + u16be(data, 18),
    height: u16be(data, 20) * 0x1_00_00 + u16be(data, 22),
  };
}

function gifSize(data: Uint8Array): ImageDimensions | undefined {
  if (data.length < 10) {
    return undefined;
  }
  if (!ascii(data, 0, "GIF87a") && !ascii(data, 0, "GIF89a")) {
    return undefined;
  }
  return { width: u16le(data, 6), height: u16le(data, 8) };
}

function jpegSize(data: Uint8Array): ImageDimensions | undefined {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) {
    return undefined;
  }
  let offset = 2;
  while (offset + 4 <= data.length) {
    if (data[offset] !== 0xff) {
      return undefined;
    }
    const marker = data[offset + 1] ?? 0;
    // Padding and markers without a length field.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }
    const length = u16be(data, offset + 2);
    if (length < 2) {
      return undefined;
    }
    if (JPEG_FRAME_MARKERS.has(marker)) {
      if (offset + 9 > data.length) {
        return undefined;
      }
      return {
        height: u16be(data, offset + 5),
        width: u16be(data, offset + 7),
      };
    }
    offset += 2 + length;
  }
  return undefined;
}

function webpSize(data: Uint8Array): ImageDimensions | undefined {
  if (data.length < 30 || !ascii(data, 0, "RIFF") || !ascii(data, 8, "WEBP")) {
    return undefined;
  }
  // Extended format stores the canvas size minus one, three bytes per axis.
  if (ascii(data, 12, "VP8X")) {
    return { width: u24le(data, 24) + 1, height: u24le(data, 27) + 1 };
  }
  if (ascii(data, 12, "VP8 ")) {
    // Lossy: a three-byte frame tag, a three-byte start code, then both sizes.
    if (data[23] !== 0x9d || data[24] !== 0x01 || data[25] !== 0x2a) {
      return undefined;
    }
    return {
      width: u16le(data, 26) & 0x3f_ff,
      height: u16le(data, 28) & 0x3f_ff,
    };
  }
  if (ascii(data, 12, "VP8L")) {
    if (data[20] !== 0x2f) {
      return undefined;
    }
    const packed = u32le(data, 21);
    return {
      width: (packed & 0x3f_ff) + 1,
      height: ((packed >> 14) & 0x3f_ff) + 1,
    };
  }
  return undefined;
}

/**
 * Read the intrinsic dimensions declared by a PNG, JPEG, GIF, or WebP header.
 *
 * PNG, GIF, and WebP declare the size early: 32 bytes answer for all three. A JPEG
 * puts its frame header behind the metadata segments a camera writes, so a caller that
 * reads a short head must widen it before it decides the file declares no size.
 * @param data - the bytes of the file head.
 * @returns the declared size, or undefined when the bytes are not one of those formats.
 */
export function imageDimensions(data: Uint8Array): ImageDimensions | undefined {
  return pngSize(data) ?? jpegSize(data) ?? gifSize(data) ?? webpSize(data);
}
