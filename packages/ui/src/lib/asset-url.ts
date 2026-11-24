/**
 * The address of an asset: the two uses of `/api/asset`, bytes and upload.
 *
 * Addresses start from `document.baseURI`, so a deployment prefix and the desktop's
 * custom protocol both carry over — the same spelling the workspace file viewer uses.
 */
import type { AssetOwnerKind } from "@workspace/agent-client";

export type { AssetOwnerKind };

export interface AssetOwner {
  readonly kind: AssetOwnerKind;
  readonly id: string;
}

/** The upload entry point: `POST` here with a multipart body. */
export function assetEndpoint(): string {
  return new URL("api/asset", document.baseURI).href;
}

/**
 * The address of one asset, ready for `<img src>`.
 *
 * `token` is a revalidation token, not the file version: passing the Bot's `updatedAt`
 * makes the address change whenever the Bot changes, so a replaced image is fetched
 * again. A token that does not match the file's version costs one redirect to the
 * versioned address, which is what the route would answer anyway.
 */
export function assetUrl(
  owner: AssetOwner,
  name: string,
  token?: number | string
): string {
  const url = new URL(assetEndpoint());

  url.searchParams.set("owner", `${owner.kind}:${owner.id}`);
  url.searchParams.set("name", name);
  if (token !== undefined) {
    url.searchParams.set("v", String(token));
  }

  return url.href;
}
