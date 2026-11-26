import { deflateSync } from "node:zlib";

import { describe, expect, test } from "vitest";

import {
  chooseSource,
  decodePng,
  encodeIco,
  firstColour,
  ICONSET,
  MIN_PNG_SIZE,
  parseArguments,
  PNG_SIGNATURE,
  pngSize,
  sourceProblem,
  svgSize,
  TRAY_SIZE_2X,
} from "./app-icons.js";

/**
 * Wraps a chunk body in a length and a type.
 *
 * The reader under test reads no checksum, so its place holds zeroes. The length still has to
 * be right, because the reader walks the chunks by it.
 */
const chunk = (type: string, body: Buffer): Buffer => {
  const head = Buffer.alloc(8);

  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "latin1");

  return Buffer.concat([head, body, Buffer.alloc(4)]);
};

/** Builds a PNG from scanlines that a test wrote by hand. A row starts with its filter type. */
const buildPng = (input: {
  colourType: number;
  height: number;
  rows: number[][];
  width: number;
}): Buffer => {
  const header = Buffer.alloc(13);

  header.writeUInt32BE(input.width, 0);
  header.writeUInt32BE(input.height, 4);
  header.writeUInt8(8, 8);
  header.writeUInt8(input.colourType, 9);

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.from(input.rows.flat()))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
};

/** One grey row, read as a tray image. */
const trayImage = (rgba: number[]) => ({
  height: 1,
  rgba: Buffer.from(rgba),
  width: rgba.length / 4,
});

describe(decodePng, () => {
  test("a scanline with no filter keeps its bytes", () => {
    // One pixel, filter 0, then 10, 20, 30, 255.
    const png = buildPng({
      colourType: 6,
      height: 1,
      rows: [[0, 10, 20, 30, 255]],
      width: 1,
    });

    expect([...decodePng(png).rgba]).toStrictEqual([10, 20, 30, 255]);
  });

  test("a Sub scanline adds the pixel on its left", () => {
    // Pixels are 255,0,0,255 then 0,255,0,255 then 0,0,255,255.
    // Each row byte holds its pixel minus the pixel on its left, modulo 256.
    const png = buildPng({
      colourType: 6,
      height: 1,
      rows: [[1, 255, 0, 0, 255, 1, 255, 0, 0, 0, 1, 255, 0]],
      width: 3,
    });

    expect([...decodePng(png).rgba]).toStrictEqual([
      255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255,
    ]);
  });

  test("an Up scanline adds the pixel above it", () => {
    // The first pixel is 10,20,30,255. The next row stores 200-10, 100-20, 50-30, 255-255.
    const png = buildPng({
      colourType: 6,
      height: 2,
      rows: [
        [0, 10, 20, 30, 255],
        [2, 190, 80, 20, 0],
      ],
      width: 1,
    });

    expect([...decodePng(png).rgba]).toStrictEqual([
      10, 20, 30, 255, 200, 100, 50, 255,
    ]);
  });

  test("an Average scanline adds half of its two neighbours", () => {
    // Width 1 has no left neighbour, so the predictor is half of the pixel above.
    // The second row stores 200-5, 100-10, 50-15, 255-127.
    const png = buildPng({
      colourType: 6,
      height: 2,
      rows: [
        [0, 10, 20, 30, 255],
        [3, 195, 90, 35, 128],
      ],
      width: 1,
    });

    expect([...decodePng(png).rgba]).toStrictEqual([
      10, 20, 30, 255, 200, 100, 50, 255,
    ]);
  });

  test("a Paeth scanline picks the nearest of three neighbours", () => {
    // The top row is 10,20,30,255 and 40,50,60,255.
    // The second row is 70,80,90,255 and 100,110,120,255.
    // Its first pixel predicts from the pixel above; its second predicts from its left.
    const png = buildPng({
      colourType: 6,
      height: 2,
      rows: [
        [0, 10, 20, 30, 255, 40, 50, 60, 255],
        [4, 60, 60, 60, 0, 30, 30, 30, 0],
      ],
      width: 2,
    });

    expect([...decodePng(png).rgba]).toStrictEqual([
      10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, 100, 110, 120, 255,
    ]);
  });

  test("a grey PNG repeats its one channel, and it is opaque", () => {
    const png = buildPng({
      colourType: 0,
      height: 1,
      rows: [[0, 128]],
      width: 1,
    });

    expect([...decodePng(png).rgba]).toStrictEqual([128, 128, 128, 255]);
  });
});

describe(firstColour, () => {
  test("a grey image has no colour", () => {
    expect(
      firstColour(trayImage([0, 0, 0, 255, 255, 255, 255, 255]))
    ).toBeUndefined();
  });

  test("a grey image with a faint tint has no colour", () => {
    expect(
      firstColour(trayImage([128, 130, 129, 255, 255, 255, 255, 255]))
    ).toBeUndefined();
  });

  test("colour behind a transparent pixel is not colour", () => {
    expect(
      firstColour(trayImage([255, 0, 0, 0, 0, 0, 0, 255]))
    ).toBeUndefined();
  });

  test("an opaque coloured pixel is where the source stops being one grey", () => {
    expect(
      firstColour(trayImage([0, 0, 0, 255, 255, 0, 0, 255, 0, 0, 0, 255]))
    ).toStrictEqual({ x: 1, y: 0 });
  });
});

/** Two images, one of them at the edge that the format stores as 0. */
const twoImages = () =>
  encodeIco([
    { png: Buffer.from([1, 2, 3]), size: 16 },
    { png: Buffer.from([4, 5]), size: 256 },
  ]);

describe(encodeIco, () => {
  test("the header names the format and the number of images", () => {
    const ico = twoImages();

    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(2);
    expect(ico).toHaveLength(6 + 2 * 16 + 5);
  });

  test("an entry stores its edge", () => {
    const ico = twoImages();

    expect(ico.readUInt8(6)).toBe(16);
    expect(ico.readUInt8(7)).toBe(16);
    expect(ico.readUInt16LE(10)).toBe(1);
    expect(ico.readUInt16LE(12)).toBe(32);
  });

  test("an edge of 256 stores as 0", () => {
    const ico = twoImages();

    expect(ico.readUInt8(22)).toBe(0);
    expect(ico.readUInt8(23)).toBe(0);
  });

  test("an entry points at its own bytes", () => {
    const ico = twoImages();

    expect(ico.readUInt32LE(14)).toBe(3);
    expect(ico.readUInt32LE(18)).toBe(38);
    expect(ico.readUInt32LE(30)).toBe(2);
    expect(ico.readUInt32LE(34)).toBe(41);
    expect([...ico.subarray(38)]).toStrictEqual([1, 2, 3, 4, 5]);
  });
});

describe(sourceProblem, () => {
  test("a square SVG is a source", () => {
    expect(
      sourceProblem({ height: 1024, width: 1024 }, "svg", MIN_PNG_SIZE)
    ).toBeUndefined();
  });

  test("a wide source is not a source", () => {
    expect(
      sourceProblem({ height: 512, width: 1024 }, "svg", MIN_PNG_SIZE)
    ).toContain("square");
  });

  test("a small PNG is not a source", () => {
    expect(
      sourceProblem({ height: 512, width: 512 }, "png", MIN_PNG_SIZE)
    ).toContain("1024");
  });

  test("a tray PNG needs only the Retina size", () => {
    expect(
      sourceProblem({ height: 64, width: 64 }, "png", TRAY_SIZE_2X)
    ).toBeUndefined();
  });

  test("a source without a size is not a source", () => {
    expect(sourceProblem({ height: 0, width: 0 }, "svg", MIN_PNG_SIZE)).toBe(
      "the source has no size"
    );
  });
});

describe(svgSize, () => {
  test("width and height give the size", () => {
    expect(svgSize('<svg width="1024" height="1024"></svg>')).toStrictEqual({
      height: 1024,
      width: 1024,
    });
  });

  test("a unit on the length does not matter", () => {
    expect(svgSize('<svg width="1024px" height="1024px"></svg>')).toStrictEqual(
      { height: 1024, width: 1024 }
    );
  });

  test("a viewBox gives the size when the lengths are absent", () => {
    expect(svgSize('<svg viewBox="0 0 512 512"></svg>')).toStrictEqual({
      height: 512,
      width: 512,
    });
  });

  test("a stroke width is not the width of the image", () => {
    expect(
      svgSize('<svg viewBox="0 0 512 512" stroke-width="4"></svg>')
    ).toStrictEqual({ height: 512, width: 512 });
  });

  test("an SVG with no size has no size", () => {
    expect(svgSize("<svg></svg>")).toBeUndefined();
  });
});

describe(pngSize, () => {
  test("a file that is not a PNG is not read", () => {
    expect(() => pngSize(Buffer.from("not a png at all"))).toThrow("not a PNG");
  });

  test("the header carries the size", () => {
    const png = buildPng({ colourType: 6, height: 3, rows: [], width: 2 });

    expect(pngSize(png)).toStrictEqual({ height: 3, width: 2 });
  });
});

describe("the iconset", () => {
  test("every Retina name is twice its base", () => {
    const base = new Map(ICONSET.map(([size, name]) => [name, size]));

    for (const [size, name] of ICONSET) {
      if (!name.endsWith("@2x")) {
        continue;
      }

      expect(size).toBe((base.get(name.slice(0, -3)) ?? 0) * 2);
    }
  });

  test("it covers every size that iconutil needs", () => {
    expect([...new Set(ICONSET.map(([size]) => size))]).toStrictEqual([
      16, 32, 64, 128, 256, 512, 1024,
    ]);
  });
});

describe(parseArguments, () => {
  test("no path is no name for either role", () => {
    expect(parseArguments([])).toStrictEqual({
      appIcon: undefined,
      tray: undefined,
    });
  });

  test("a path names the app icon", () => {
    expect(parseArguments(["other.svg"])).toStrictEqual({
      appIcon: "other.svg",
      tray: undefined,
    });
  });

  test("--tray names the tray icon", () => {
    expect(parseArguments(["other.svg", "--tray", "tray.svg"])).toStrictEqual({
      appIcon: "other.svg",
      tray: "tray.svg",
    });
  });

  test("--tray without a file stops the run", () => {
    expect(() => parseArguments(["--tray"])).toThrow("--tray needs a file");
  });

  test("a second source stops the run", () => {
    expect(() => parseArguments(["one.svg", "two.png"])).toThrow(
      "unexpected argument"
    );
  });
});

/** The source files that a role's directory holds, for `chooseMaster`. */
const holding =
  (...files: string[]) =>
  (candidate: string) =>
    files.includes(candidate);

describe(chooseSource, () => {
  const candidates = ["brand/app-icon.svg", "brand/app-icon.png"];

  test("the name that exists is the source", () => {
    expect(
      chooseSource({
        candidates,
        exists: holding("brand/app-icon.svg"),
        name: "app icon",
      })
    ).toBe("brand/app-icon.svg");
  });

  test("a PNG fills the role when there is no SVG", () => {
    expect(
      chooseSource({
        candidates,
        exists: holding("brand/app-icon.png"),
        name: "app icon",
      })
    ).toBe("brand/app-icon.png");
  });

  test("two sources are one too many", () => {
    expect(() =>
      chooseSource({
        candidates,
        exists: holding("brand/app-icon.svg", "brand/app-icon.png"),
        name: "app icon",
      })
    ).toThrow("two sources");
  });

  test("no name is no source, and the caller decides what that means", () => {
    expect(
      chooseSource({ candidates, exists: holding(), name: "app icon" })
    ).toBeUndefined();
  });
});
