/**
 * Builds the app icon and the tray icon from their sources in `brand/`.
 *
 * Usage: `tsx scripts/generate-icons.ts [app-icon.svg | app-icon.png] [--tray tray-icon.svg | tray-icon.png]`
 *
 * An icon role has at most one source, found by a fixed name in `brand/`: an SVG, or a PNG
 * when there is no SVG. The command line can name another file for one run.
 *
 * The tool writes into the repository, so it is a local authoring tool. It needs `sips` and
 * `iconutil`, which ship with macOS, and it never runs in CI.
 *
 * `scripts/app-icons.ts` holds the rules. This file runs the tools and writes the files.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
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
  chooseSource,
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

const ROOT = path.resolve(import.meta.dirname, "..");

/** One icon role: the names that it accepts, its size floor, and how a message names it. */
type IconRole = {
  candidates: readonly string[];
  minimum: number;
  name: string;
};

/** The app icon. Its source is required. */
const APP_ICON: IconRole = {
  candidates: ["brand/app-icon.svg", "brand/app-icon.png"],
  minimum: MIN_PNG_SIZE,
  name: "app icon",
};

/** The tray icon. It has no source until a person draws one. */
const TRAY_ICON: IconRole = {
  candidates: ["brand/tray-icon.svg", "brand/tray-icon.png"],
  minimum: TRAY_SIZE_2X,
  name: "tray icon",
};

/** The app icon files, next to the Forge icon setting. */
const ICONS_DIR = path.join(ROOT, "apps/desktop/resources/icons");

/** The favicon of the web entry. */
const FAVICON_ICO = path.join(ROOT, "apps/web/public/favicon.ico");

/** A source file after the tool checked its format and its size. */
type Source = {
  /** The path as the command line or the role file named it. */
  given: string;
  /** The path on disk. */
  path: string;
};

/** The path on disk of a path that a message shows. */
const onDisk = (file: string): string =>
  path.isAbsolute(file) ? file : path.join(ROOT, file);

/** Whether the repository holds this file. */
const holds = (file: string): boolean => existsSync(onDisk(file));

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
const openSource = (given: string, role: IconRole): Source => {
  const format = sourceFormatOf(given);
  const file = onDisk(given);

  if (format === undefined) {
    throw new Error(
      `the ${role.name} source must be an SVG or a PNG: ${given}`
    );
  }

  let bytes: Buffer;

  try {
    bytes = readFileSync(file);
  } catch {
    throw new Error(`the ${role.name} source is missing: ${given}`);
  }

  const size = readSourceSize(bytes, format);

  if (size === undefined) {
    throw new Error(
      `the ${role.name} source has no size; an SVG needs width and height, or a viewBox: ${given}`
    );
  }

  const problem = sourceProblem(size, format, role.minimum);

  if (problem !== undefined) {
    throw new Error(`the ${role.name} source: ${problem}: ${given}`);
  }

  return { given, path: file };
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
      `the ${TRAY_ICON.name} source carries colour at ${String(colour.x)},${String(colour.y)}: ${tray.given}; a tray icon is one grey, because macOS tints it`
    );
  }

  return { oneX: rasterise(TRAY_SIZE), twoX };
};

/** The source of one role, from the command line or from the repository. */
const sourceOf = (
  role: IconRole,
  given: string | undefined
): Source | undefined => {
  const chosen =
    given ??
    chooseSource({
      candidates: role.candidates,
      exists: holds,
      name: role.name,
    });

  return chosen === undefined ? undefined : openSource(chosen, role);
};

/** Builds every icon from the app icon source, and the tray icon from its own source. */
const build = (appIcon: Source, tray: Source | undefined): void => {
  const work = mkdtempSync(path.join(tmpdir(), "aify-icons-"));

  try {
    const rasterise = makeRasteriser(appIcon, work);
    // Every source is checked before the first write, so a bad run changes no file.
    const trayImages = tray === undefined ? undefined : readTray(tray, work);

    write(path.join(ICONS_DIR, "icon.png"), rasterise(APP_ICON_SIZE));
    write(path.join(ICONS_DIR, "icon.ico"), packIco(ICO_SIZES, rasterise));
    write(FAVICON_ICO, packIco(FAVICON_SIZES, rasterise));
    writeIcns(rasterise, work);

    if (trayImages === undefined) {
      console.log("[icons] no tray source, so the tray icon stays as it is");
    } else {
      write(path.join(ICONS_DIR, "tray.png"), trayImages.oneX);
      write(path.join(ICONS_DIR, "tray@2x.png"), trayImages.twoX);
    }
  } finally {
    rmSync(work, { force: true, recursive: true });
  }
};

const main = (): void => {
  if (process.platform !== "darwin") {
    throw new Error("sips and iconutil ship with macOS only");
  }

  const parsed = parseArguments(process.argv.slice(2));
  const appIcon = sourceOf(APP_ICON, parsed.appIcon);

  if (appIcon === undefined) {
    throw new Error(
      `the ${APP_ICON.name} source is missing: ${APP_ICON.candidates.join(" or ")}`
    );
  }

  build(appIcon, sourceOf(TRAY_ICON, parsed.tray));
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
