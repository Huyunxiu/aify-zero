/**
 * Attachment storage: immutable, content-addressed bytes under one session directory.
 *
 * A transcript records what a read produced. A path in that record would point at a
 * file the user can change or delete, so the bytes are copied here once, named by
 * their digest, and never rewritten. Two reads of the same file therefore cost one
 * object, and a replay always shows the bytes that read produced.
 *
 * The directory sits beside `assets/`, which serves a different fact: an asset is a
 * mutable file owned by a Bot or a session.
 *
 * @module
 */

import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { isAttachmentDigest } from "@workspace/agent-client";
import type { AttachmentRef } from "@workspace/agent-client";

/** The directory that holds one session's attachments. */
export function attachmentDir(sessionDir: string): string {
  return join(sessionDir, "attachments");
}

/** The object path for one digest. */
export function attachmentPath(sessionDir: string, sha256: string): string {
  if (!isAttachmentDigest(sha256)) {
    throw new Error(`attachment: "${sha256}" is not a digest`);
  }
  return join(attachmentDir(sessionDir), sha256);
}

/** Bytes and facts a caller offers for storage. */
export interface SaveAttachmentInput {
  /** The owning session's private directory. */
  readonly sessionDir: string;
  /** The owner recorded on the reference, `session:<id>`. */
  readonly owner: string;
  readonly data: Uint8Array;
  readonly mediaType: string;
  /** Intrinsic width in pixels, when the header declares one. */
  readonly width?: number;
  readonly height?: number;
  /** The resolved source path, so a later read can find it again. */
  readonly name?: string;
  /** The source size after orientation, when the stored copy was reduced. */
  readonly originalDimensions?: {
    readonly width: number;
    readonly height: number;
  };
}

/**
 * Store bytes and return the reference that names them.
 *
 * The write is content-addressed, so a second read of the same bytes finds the object
 * already there and leaves it alone. A rename publishes the object, which keeps a
 * reader from ever seeing a partial file.
 * @param input - bytes, media type, and the facts a reference carries.
 * @returns the durable reference.
 */
export async function saveAttachment(
  input: SaveAttachmentInput
): Promise<AttachmentRef> {
  const sha256 = createHash("sha256").update(input.data).digest("hex");
  const dir = attachmentDir(input.sessionDir);
  await mkdir(dir, { recursive: true });

  const target = attachmentPath(input.sessionDir, sha256);
  // The name is the digest, so an existing object already holds these bytes.
  if (
    await stat(target).then(
      (info) => info.isFile(),
      () => false
    )
  ) {
    return reference(input, sha256);
  }

  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, input.data, { flag: "wx" });
    await rename(temporary, target);
  } catch (error) {
    try {
      await unlink(temporary);
    } catch {
      // The temporary name may already be gone; the write failure is the news.
    }
    throw error;
  }

  return reference(input, sha256);
}

/** The durable reference for one stored object. */
function reference(input: SaveAttachmentInput, sha256: string): AttachmentRef {
  return {
    type: "attachment",
    sha256,
    owner: input.owner,
    mediaType: input.mediaType,
    bytes: input.data.byteLength,
    ...(input.width === undefined ? {} : { width: input.width }),
    ...(input.height === undefined ? {} : { height: input.height }),
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.originalDimensions === undefined
      ? {}
      : {
          originalDimensions: {
            width: input.originalDimensions.width,
            height: input.originalDimensions.height,
          },
        }),
  };
}

/**
 * Read the bytes a reference names.
 *
 * The digest is checked before the bytes are returned: a stored object that does not
 * hash to its name would silently change what the model sees.
 * @param sessionDir - the owning session's private directory.
 * @param ref - the durable reference.
 * @returns the stored bytes.
 */
export async function readAttachment(
  sessionDir: string,
  ref: AttachmentRef
): Promise<Uint8Array> {
  const data = new Uint8Array(
    await readFile(attachmentPath(sessionDir, ref.sha256))
  );
  const digest = createHash("sha256").update(data).digest("hex");
  if (digest !== ref.sha256) {
    throw new Error(
      `attachment "${ref.sha256}" does not match its stored bytes`
    );
  }
  return data;
}
