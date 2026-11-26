/**
 * The attachment vocabulary both sides need: an immutable reference to bytes that a
 * session recorded, and the limits a read enforces before those bytes exist.
 *
 * It lives in the protocol package for the same reason `asset.ts` does: the agent
 * writes the reference, the server serves the bytes, and the interface renders them,
 * so one declaration keeps the three from drifting.
 *
 * An attachment is not an asset. An asset is a mutable file under its owner's
 * `assets/`; a name can be overwritten and deleted. An attachment is immutable and
 * addressed by its digest, because a transcript that replays an old read must show
 * the bytes that read produced.
 */

/** The largest image an attachment accepts, in bytes. */
export const ATTACHMENT_MAX_BYTES = 2 * 1024 * 1024;

/** The largest image an attachment accepts, in decoded pixels. */
export const ATTACHMENT_MAX_PIXELS = 20_000_000;

/** The image formats a read commits as an attachment. */
export const ATTACHMENT_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

/** The part of an image a read stored, as fractions of the source. */
export interface AttachmentRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** An immutable reference to bytes a session recorded. */
export interface AttachmentRef {
  /** Discriminates this from the deprecated inline `file-data` upload. */
  type: "attachment";
  /** Digest of the stored bytes, 64 lower-case hex characters. */
  sha256: string;
  /** The owner the bytes live under, `session:<id>`; the byte route reads it. */
  owner: string;
  /** Verified media type of the stored bytes. */
  mediaType: string;
  /** Exact stored byte length. */
  bytes: number;
  /** Intrinsic width in pixels; absent when the header carries no size. */
  width?: number;
  /** Intrinsic height in pixels; absent when the header carries no size. */
  height?: number;
  /** The resolved path the read came from, for a later re-read. */
  name?: string;
  /**
   * The source size after orientation and before the stored copy was reduced. Present
   * only when the stored copy is smaller, so a reader can map coordinates back.
   */
  originalDimensions?: {
    width: number;
    height: number;
  };
  /** The fraction of the source this copy shows, present only for a partial read. */
  region?: AttachmentRegion;
}

/** The owner string of one session's attachments. */
export function attachmentOwner(sessionId: string): string {
  return `session:${sessionId}`;
}

/** Whether a string is an attachment digest: 64 lower-case hex characters. */
export function isAttachmentDigest(value: string): boolean {
  return /^[\da-f]{64}$/u.test(value);
}
