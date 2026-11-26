/**
 * The rules that build the app icon and the tray icon from a logo source.
 *
 * One logo source is the authority for the app icon, the Windows icon, and the web favicon.
 * The tray icon has its own source: a tray glyph is a flat monochrome drawing, and an app icon
 * is an opaque rounded square. `scripts/generate-icons.ts` is the command that calls this file.
 *
 * The file holds no side effect and runs no tool, so a test can call every rule.
 */

import { inflateSync } from "node:zlib";

/** The size of the dock icon. */
export const APP_ICON_SIZE = 512;

/** The sizes of the Windows icon. 256 is the largest that the format can hold. */
export const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

/** The sizes of the favicon. A browser tab never needs more than 64. */
export const FAVICON_SIZES = [16, 24, 32, 48, 64];

/** A tray icon is 16 points; a Retina display asks for the second copy. */
export const TRAY_SIZE = 32;
export const TRAY_SIZE_2X = 64;

/** The smallest PNG source that can fill the largest icon without scaling up. */
export const MIN_PNG_SIZE = 1024;

/** A tray pixel counts as grey when its channels differ by no more than this. */
const GREY_TOLERANCE = 8;

/** The size of every image of the macOS iconset, and the name that `iconutil` reads. */
export const ICONSET: readonly (readonly [number, string])[] = [
  [16, "icon_16x16"],
  [32, "icon_16x16@2x"],
  [32, "icon_32x32"],
  [64, "icon_32x32@2x"],
  [128, "icon_128x128"],
  [256, "icon_128x128@2x"],
  [256, "icon_256x256"],
  [512, "icon_256x256@2x"],
  [512, "icon_512x512"],
  [1024, "icon_512x512@2x"],
];

/** The format of a file that the tool can read as a source. */
export type SourceFormat = "png" | "svg";

/** The pixel size of a source, or of a built image. */
export type ImageSize = { height: number; width: number };

/** The format of a source file name, or `undefined` when the tool cannot read it. */
export const sourceFormatOf = (file: string): SourceFormat | undefined => {
  const lower = file.toLowerCase();

  if (lower.endsWith(".svg")) {
    return "svg";
  }

  return lower.endsWith(".png") ? "png" : undefined;
};

/** The eight bytes that start a PNG file. */
export const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/** Reads the size in the header of a PNG. */
export const pngSize = (bytes: Buffer): ImageSize => {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("the file is not a PNG");
  }

  return { height: bytes.readUInt32BE(20), width: bytes.readUInt32BE(16) };
};

/** Reads a length that may carry a unit, such as `1024px`. */
const lengthOf = (value: string | undefined): number | undefined => {
  if (value === undefined) {
    return undefined;
  }

  const number = Number.parseFloat(value);

  return Number.isFinite(number) ? number : undefined;
};

/**
 * Reads the size that an SVG declares.
 *
 * An SVG has a size when it names `width` and `height`, or when it names a `viewBox`. A file
 * with neither cannot be scaled, so the tool reports it instead of guessing.
 */
export const svgSize = (text: string): ImageSize | undefined => {
  const tag = /<svg[^>]*>/i.exec(text)?.[0];

  if (tag === undefined) {
    return undefined;
  }

  const attributeOf = (name: string) =>
    new RegExp(`(?<![-\\w])${name}\\s*=\\s*["']([^"']+)["']`, "i").exec(
      tag
    )?.[1];

  const width = lengthOf(attributeOf("width"));
  const height = lengthOf(attributeOf("height"));

  if (width !== undefined && height !== undefined) {
    return { height, width };
  }

  const box = attributeOf("viewBox")
    ?.trim()
    .split(/[\s,]+/)
    .map((part) => Number.parseFloat(part));

  if (box?.length !== 4) {
    return undefined;
  }

  const [boxWidth, boxHeight] = box.slice(2);

  if (boxWidth === undefined || boxHeight === undefined) {
    return undefined;
  }

  return { height: boxHeight, width: boxWidth };
};

/** Reads the size of a source file, by its format. */
export const readSourceSize = (
  bytes: Buffer,
  format: SourceFormat
): ImageSize | undefined =>
  format === "png" ? pngSize(bytes) : svgSize(bytes.toString("utf-8"));

/**
 * The reason that a source cannot become an icon, or `undefined` when it can.
 *
 * `minimum` is the smallest side that a raster source may have. A vector source has no
 * minimum, because it scales without loss.
 */
export const sourceProblem = (
  size: ImageSize,
  format: SourceFormat,
  minimum: number
): string | undefined => {
  const { height, width } = size;

  if (!(width > 0 && height > 0)) {
    return "the source has no size";
  }

  if (width !== height) {
    return `the source is ${width}x${height}, and an icon is square`;
  }

  if (format === "png" && height < minimum) {
    return `the PNG source is ${width}x${height}, and it needs at least ${minimum} on each side`;
  }

  return undefined;
};

/** The channels of an 8-bit PNG, by colour type. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

/** One PNG as straight RGBA bytes, one pixel after another. */
export type DecodedPng = ImageSize & { rgba: Buffer };

/** The nearest of the three neighbours, as the PNG filter 4 defines it. */
const paeth = (left: number, above: number, upperLeft: number): number => {
  const estimate = left + above - upperLeft;
  const toLeft = Math.abs(estimate - left);
  const toAbove = Math.abs(estimate - above);
  const toUpperLeft = Math.abs(estimate - upperLeft);

  if (toLeft <= toAbove && toLeft <= toUpperLeft) {
    return left;
  }

  return toAbove <= toUpperLeft ? above : upperLeft;
};

/** Reverses one scanline that a PNG filter changed. */
const unfilter = (
  type: number,
  line: Buffer,
  previous: Buffer,
  bytesPerPixel: number
): Buffer => {
  const out = Buffer.alloc(line.length);

  for (let index = 0; index < line.length; index += 1) {
    const raw = line[index] ?? 0;
    const left = index >= bytesPerPixel ? (out[index - bytesPerPixel] ?? 0) : 0;
    const above = previous[index] ?? 0;
    const upperLeft =
      index >= bytesPerPixel ? (previous[index - bytesPerPixel] ?? 0) : 0;

    switch (type) {
      case 0: {
        out[index] = raw;
        break;
      }
      case 1: {
        out[index] = (raw + left) & 0xff;
        break;
      }
      case 2: {
        out[index] = (raw + above) & 0xff;
        break;
      }
      case 3: {
        out[index] = (raw + ((left + above) >> 1)) & 0xff;
        break;
      }
      case 4: {
        out[index] = (raw + paeth(left, above, upperLeft)) & 0xff;
        break;
      }
      default: {
        throw new Error(`the PNG uses the unknown filter ${type}`);
      }
    }
  }

  return out;
};

/**
 * Decodes an 8-bit PNG into straight RGBA.
 *
 * The tool decodes only the PNG files that it just built with `sips`, so it accepts the four
 * 8-bit colour types and no interlacing, and it reports anything else instead of guessing.
 * It reads no checksum: the bytes come from the same run, not from a network.
 */
export const decodePng = (bytes: Buffer): DecodedPng => {
  const { height, width } = pngSize(bytes);
  const idat: Buffer[] = [];
  let channels: number | undefined;
  let offset = 8;

  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    const body = bytes.subarray(offset + 8, offset + 8 + length);

    offset += length + 12;

    if (type === "IHDR") {
      const header = body.subarray(8, 13);
      const depth = header.at(0);
      const colourType = header.at(1) ?? -1;
      const interlace = header.at(4);

      channels = CHANNELS[colourType];

      if (depth !== 8 || channels === undefined || interlace !== 0) {
        throw new Error(
          `the PNG is bit depth ${String(depth)}, colour type ${colourType}, interlace ${String(interlace)}; the tool reads 8-bit non-interlaced PNG only`
        );
      }
    }

    if (type === "IDAT") {
      idat.push(body);
    }
  }

  if (channels === undefined) {
    throw new Error("the PNG has no header");
  }

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const rgba = Buffer.alloc(width * height * 4);
  let previous: Buffer = Buffer.alloc(stride);
  let cursor = 0;

  for (let row = 0; row < height; row += 1) {
    const type = raw[cursor] ?? 0;
    const line = unfilter(
      type,
      raw.subarray(cursor + 1, cursor + 1 + stride),
      previous,
      channels
    );

    cursor += stride + 1;
    previous = line;

    for (let column = 0; column < width; column += 1) {
      const from = column * channels;
      const to = (row * width + column) * 4;
      const grey = line[from] ?? 0;

      rgba[to] = grey;
      rgba[to + 1] = channels >= 3 ? (line[from + 1] ?? 0) : grey;
      rgba[to + 2] = channels >= 3 ? (line[from + 2] ?? 0) : grey;
      rgba[to + 3] =
        channels === 2 || channels === 4
          ? (line[from + channels - 1] ?? 0)
          : 255;
    }
  }

  return { height, rgba, width };
};

/** The first coloured pixel of a tray icon, or `undefined` when the whole image is grey. */
export const firstColour = (
  image: DecodedPng
): { x: number; y: number } | undefined => {
  const { height, rgba, width } = image;

  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const at = (row * width + column) * 4;
      const red = rgba[at] ?? 0;
      const green = rgba[at + 1] ?? 0;
      const blue = rgba[at + 2] ?? 0;
      const alpha = rgba[at + 3] ?? 0;

      if (alpha === 0) {
        continue;
      }

      if (
        Math.abs(red - green) > GREY_TOLERANCE ||
        Math.abs(green - blue) > GREY_TOLERANCE ||
        Math.abs(red - blue) > GREY_TOLERANCE
      ) {
        return { x: column, y: row };
      }
    }
  }

  return undefined;
};

/** One image of an ICO file. The format stores a PNG for each size. */
export type IcoEntry = { png: Buffer; size: number };

/**
 * Packs images into an ICO file.
 *
 * The format holds a directory of 16-byte rows, then the images. A row stores the width and
 * the height in one byte each, where 0 means 256, and the offset of its image from the start
 * of the file.
 */
export const encodeIco = (entries: IcoEntry[]): Buffer => {
  const body = Buffer.alloc(
    entries.reduce((sum, entry) => sum + entry.png.length, 0)
  );
  const header = Buffer.alloc(6 + entries.length * 16);
  let bodyOffset = 0;

  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);

  for (const [index, entry] of entries.entries()) {
    const at = 6 + index * 16;
    const edge = entry.size >= 256 ? 0 : entry.size;

    header.writeUInt8(edge, at);
    header.writeUInt8(edge, at + 1);
    header.writeUInt8(0, at + 2);
    header.writeUInt8(0, at + 3);
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(entry.png.length, at + 8);
    header.writeUInt32LE(header.length + bodyOffset, at + 12);

    entry.png.copy(body, bodyOffset);
    bodyOffset += entry.png.length;
  }

  return Buffer.concat([header, body]);
};

/**
 * Reads the command line into an optional app icon source and an optional tray source.
 *
 * Both are `undefined` when the command line does not name them, and the caller then takes
 * the role file from `brand/`.
 */
export const parseArguments = (
  argv: string[]
): {
  appIcon: string | undefined;
  tray: string | undefined;
} => {
  const remaining = [...argv];
  const trayIndex = remaining.indexOf("--tray");
  let tray: string | undefined;

  if (trayIndex !== -1) {
    tray = remaining[trayIndex + 1];

    if (tray === undefined || tray.startsWith("--")) {
      throw new Error("--tray needs a file");
    }

    remaining.splice(trayIndex, 2);
  }

  const appIcon = remaining.shift();

  if (remaining.length > 0) {
    throw new Error(
      `one app icon source only; unexpected argument: ${remaining[0] ?? ""}`
    );
  }

  return { appIcon, tray };
};

/**
 * The one source of an icon role, from the names that it accepts.
 *
 * A role has at most one source. Two of them drift apart, so the caller stops the run
 * instead of picking one.
 */
export const chooseSource = (input: {
  /** The names that the role accepts, in the order that a message shows them. */
  candidates: readonly string[];
  /** Whether a name is on disk. */
  exists: (candidate: string) => boolean;
  /** The role, as a phrase that a message can name. */
  name: string;
}): string | undefined => {
  const found = input.candidates.filter((candidate) => input.exists(candidate));
  const [only, ...more] = found;

  if (more.length > 0) {
    throw new Error(
      `two sources for ${input.name}: ${found.join(", ")}; keep one`
    );
  }

  if (only === undefined) {
    return undefined;
  }

  return only;
};
