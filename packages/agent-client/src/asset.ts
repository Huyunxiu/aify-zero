/**
 * The asset vocabulary both sides need: who may own an asset, and what an image may be.
 *
 * It lives in the protocol package because the server validates it and the interface
 * spells it in an `accept` attribute; one list keeps them from drifting.
 */

/** The kinds of owner that can hold assets. */
export const ASSET_OWNER_KINDS = ["bot", "session"] as const;

export type AssetOwnerKind = (typeof ASSET_OWNER_KINDS)[number];

/** The image formats an avatar accepts. */
export const ASSET_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;

/** The largest image an avatar accepts, in bytes. */
export const ASSET_MAX_BYTES = 2 * 1024 * 1024;
