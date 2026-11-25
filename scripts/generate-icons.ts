/**
 * Builds every icon from one logo source.
 *
 * Usage: `tsx scripts/generate-icons.ts [logo.svg | logo.png] [--tray tray.svg | tray.png]`
 *
 * The tool writes into the repository, so it is a local authoring tool. It needs `sips` and
 * `iconutil`, which ship with macOS, and it never runs in CI.
 *
 * `scripts/app-icons.ts` holds the rules. This file runs the tools and writes the files.
 */

import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  APP_ICON_SIZE,
  decodePng,
  encodeIco,
  FAVICON_SIZES,
  firstColour,
  ICONSET,
  ICO_SIZES,
  MIN_PNG_SIZE,
  parseArguments,
  readSourceSize,
  sourceFormatOf,
  sourceProblem,
  TRAY_SIZE,
  TRAY_SIZE_2X,
} from "./app-icons.js";
import type { SourceFormat } from "./app-icons.js";

const ROOT = path.resolve(import.meta.dirname, "..");

/** The logo source that the command reads when it names no other. */
const DEFAULT_LOGO_SOURCE = path.join(ROOT, "brand/logo.svg");

/** The app icon files, next to the Forge icon setting. */
const ICONS_DIR = path.join(ROOT, "apps/desktop/resources/icons");

/** The app icon copy that `packages/ui` reads. */
const APP_ICON_SVG = path.join(ROOT, "packages/ui/src/assets/app-icon.svg");

/** The favicon of the web entry. */
const FAVICON_ICO = path.join(ROOT, "apps/web/public/favicon.ico");

/** A source file after the tool checked its format and its size. */
type Source = {
  bytes: Buffer;
  format: SourceFormat;
  /** The path as the command line gave it, for a message about this source. */
  given: string;
  path: string;
};

/**
 * Runs a tool and waits for it.
 *
 * The tool keeps its own error stream, so the reason from `sips` or `iconutil` reaches the
 * terminal above the message that this file prints.
 */
const run = (file: string, args: string[]): void => {
  execFileSync(file, args, { stdio: ["ignore", "ignore", "inherit"] });
};

/**
 * Reads a source file and reports why it cannot become an icon.
 *
 * A relative path resolves against the repository root, so a run gives the same result from
 * any directory.
 */
const openSource = (given: string, role: string, minimum: number): Source => {
  const format = sourceFormatOf(given);
  const file = path.isAbsolute(given) ? given : path.join(ROOT, given);

  if (format === undefined) {
    throw new Error(`${role} must be an SVG or a PNG: ${given}`);
  }

  let bytes: Buffer;

  try {
    bytes = readFileSync(file);
  } catch {
    throw new Error(`${role} is missing: ${given}`);
  }

  const size = readSourceSize(bytes, format);

  if (size === undefined) {
    throw new Error(
      `${role} has no size; an SVG needs width and height, or a viewBox: ${given}`
    );
  }

  const problem = sourceProblem(size, format, minimum);

  if (problem !== undefined) {
    throw new Error(`${role}: ${problem}: ${given}`);
  }

  return { bytes, format, given, path: file };
};

/** Writes one built file and reports it. */
const write = (target: string, bytes: Buffer): void => {
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, bytes);
  console.log(`[icons] wrote ${path.relative(ROOT, target)}`);
};

/** Rasterises one source at one size, and remembers the result. */
const makeRasteriser = (source: Source, work: string) => {
  const cache = new Map<number, Buffer>();

  return (size: number): Buffer => {
    const known = cache.get(size);

    if (known !== undefined) {
      return known;
    }

    const target = path.join(
      work,
      `${path.basename(source.path)}-${String(size)}.png`
    );

    run("sips", [
      "-s",
      "format",
      "png",
      "-z",
      String(size),
      String(size),
      source.path,
      "--out",
      target,
    ]);

    const bytes = readFileSync(target);

    cache.set(size, bytes);

    return bytes;
  };
};

/** Packs one ICO from a list of sizes. */
const packIco = (
  sizes: readonly number[],
  rasterise: (size: number) => Buffer
): Buffer => encodeIco(sizes.map((size) => ({ png: rasterise(size), size })));

/** Writes the macOS icon from the rasterised sizes. */
const writeIcns = (rasterise: (size: number) => Buffer, work: string): void => {
  const iconset = path.join(work, "icon.iconset");

  mkdirSync(iconset, { recursive: true });

  for (const [size, name] of ICONSET) {
    writeFileSync(path.join(iconset, `${name}.png`), rasterise(size));
  }

  const target = path.join(work, "icon.icns");

  run("iconutil", ["-c", "icns", iconset, "-o", target]);
  write(path.join(ICONS_DIR, "icon.icns"), readFileSync(target));
};

/**
 * Rasterises the tray source at both sizes, and stops on a source that is not one grey.
 *
 * A tray icon is a template image: macOS tints it by its alpha, so a colour would become a
 * grey blob in the menu bar.
 */
const readTray = (
  tray: Source,
  work: string
): { oneX: Buffer; twoX: Buffer } => {
  const rasterise = makeRasteriser(tray, work);
  const twoX = rasterise(TRAY_SIZE_2X);
  const colour = firstColour(decodePng(twoX));

  if (colour !== undefined) {
    throw new Error(
      `the tray source carries colour at ${String(colour.x)},${String(colour.y)}: ${tray.given}; a tray icon is one grey, because macOS tints it`
    );
  }

  return { oneX: rasterise(TRAY_SIZE), twoX };
};

/** Builds every icon from one logo source, and the tray icon from its own source. */
const build = (logo: Source, tray: Source | undefined): void => {
  const work = mkdtempSync(path.join(tmpdir(), "aify-icons-"));

  try {
    const rasterise = makeRasteriser(logo, work);
    // Every source is checked before the first write, so a bad run changes no file.
    const trayImages = tray === undefined ? undefined : readTray(tray, work);

    write(path.join(ICONS_DIR, "icon.png"), rasterise(APP_ICON_SIZE));
    write(path.join(ICONS_DIR, "icon.ico"), packIco(ICO_SIZES, rasterise));
    write(FAVICON_ICO, packIco(FAVICON_SIZES, rasterise));
    writeIcns(rasterise, work);

    if (logo.format === "svg") {
      write(path.join(ICONS_DIR, "icon.svg"), logo.bytes);
      write(APP_ICON_SVG, logo.bytes);
    }

    if (trayImages === undefined) {
      console.log("[icons] no --tray source, so the tray icon stays as it is");
    } else {
      write(path.join(ICONS_DIR, "tray.png"), trayImages.oneX);
      write(path.join(ICONS_DIR, "tray@2x.png"), trayImages.twoX);
    }

    if (logo.format === "png") {
      throw new Error(
        `the logo source is a PNG, so ${path.relative(ROOT, path.join(ICONS_DIR, "icon.svg"))} and ${path.relative(ROOT, APP_ICON_SVG)} keep the old art; pass an SVG to fill them`
      );
    }
  } finally {
    rmSync(work, { force: true, recursive: true });
  }
};

const main = (): void => {
  if (process.platform !== "darwin") {
    throw new Error("sips and iconutil ship with macOS only");
  }

  const { logo, tray } = parseArguments(
    process.argv.slice(2),
    DEFAULT_LOGO_SOURCE
  );

  build(
    openSource(logo, "the logo source", MIN_PNG_SIZE),
    tray === undefined
      ? undefined
      : openSource(tray, "the tray source", TRAY_SIZE_2X)
  );
};

try {
  main();
  console.log("[icons] done");
} catch (error) {
  console.error(
    `[icons] ${error instanceof Error ? error.message : String(error)}`
  );
  process.exitCode = 1;
}
