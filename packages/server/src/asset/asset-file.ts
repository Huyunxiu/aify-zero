/**
 * The rules for an asset file on disk: its base name, its extension, and the fact
 * that one base name keeps exactly one file.
 *
 * An asset sits under its owner's directory, named by convention (`avatar.png`). The
 * extension comes from the bytes, not from the request: swapping the format has to
 * remove the previous file, because two files for one base name force every reader to
 * choose between them.
 */
import {
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { nanoid } from "nanoid";

/** A base name: lower case, no dot, no separator, so it can never be part of a path. */
const ASSET_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/u;

/** The three accepted images; `jpeg` is stored as `.jpg`, so the two never coexist. */
const IMAGE_EXTENSIONS = ["png", "jpg", "webp"] as const;

export type ImageExtension = (typeof IMAGE_EXTENSIONS)[number];

/** Whether a base name is valid. */
export function isAssetName(name: string): boolean {
  return ASSET_NAME.test(name);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCodePoint(...bytes.subarray(offset, offset + length));
}

/**
 * The image format a byte sequence claims by its magic bytes.
 *
 * Only these three, and `null` for anything else: the `Content-Type` a client declares
 * is a claim, not evidence, so it cannot decide which extension the server writes.
 */
export function imageExtensionOf(bytes: Uint8Array): ImageExtension | null {
  const isPng =
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a;
  if (isPng) {
    return "png";
  }

  const isJpeg =
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff;
  if (isJpeg) {
    return "jpg";
  }

  const isWebp =
    bytes.length >= 12 &&
    ascii(bytes, 0, 4) === "RIFF" &&
    ascii(bytes, 8, 4) === "WEBP";
  if (isWebp) {
    return "webp";
  }

  return null;
}

/** The file of this base name in the directory, or `null` when there is none. */
export function findAssetFile(dir: string, name: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (error: unknown) {
    // A directory that is not there yet and "no asset" are the same answer.
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
    if (code === "ENOENT") {
      return null;
    }
    throw error;
  }

  for (const extension of IMAGE_EXTENSIONS) {
    const fileName = `${name}.${extension}`;
    if (entries.includes(fileName)) {
      return fileName;
    }
  }
  return null;
}

export interface WrittenAsset {
  /** The file name written to disk, such as `avatar.webp`. */
  readonly fileName: string;
  /** `mtime:size`, the same shape the byte route versions with. */
  readonly version: string;
}

/**
 * Write an asset and remove the other extensions of the same base name.
 *
 * The write goes through a temporary file and a rename: a failure halfway leaves
 * neither a half image nor a half-replaced one.
 */
export function writeAssetFile(
  dir: string,
  name: string,
  bytes: Uint8Array,
  extension: ImageExtension
): WrittenAsset {
  mkdirSync(dir, { recursive: true });

  const fileName = `${name}.${extension}`;
  const destination = join(dir, fileName);
  const temporary = join(dir, `.${name}.${nanoid()}.tmp`);

  writeFileSync(temporary, bytes);
  renameSync(temporary, destination);

  for (const other of IMAGE_EXTENSIONS) {
    if (other === extension) {
      continue;
    }
    const stale = join(dir, `${name}.${other}`);
    try {
      unlinkSync(stale);
    } catch (error: unknown) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? (error as { code?: unknown }).code
          : undefined;
      if (code !== "ENOENT") {
        throw error;
      }
    }
  }

  const info = statSync(destination);
  return {
    fileName,
    version: `${Math.floor(info.mtimeMs)}:${info.size}`,
  };
}

/** Remove every extension of this base name; returns whether anything was removed. */
export function removeAssetFiles(dir: string, name: string): boolean {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return false;
  }

  let removed = false;
  for (const extension of IMAGE_EXTENSIONS) {
    const fileName = `${name}.${extension}`;
    if (!entries.includes(fileName)) {
      continue;
    }
    unlinkSync(join(dir, fileName));
    removed = true;
  }
  return removed;
}
