/**
 * The owner's asset channel: `GET`, `POST`, and `DELETE /api/asset`.
 *
 * All three know an owner and a base name, and nothing else. A Bot avatar is one case
 * of that (`bot:<id>` with the name `avatar`), not a branch: how bytes travel is in
 * `file-response.ts`, how files land is in `asset-file.ts`, and what an owner records
 * after a write is in `asset-owners.ts`.
 *
 * Uploads take multipart. The repository had no upload path, and this route has to
 * serve more than one caller (a browser form, a script, a future screen), so the shape
 * is the one every caller already has without encoding base64 first.
 */
import { ASSET_MAX_BYTES } from "@workspace/agent-client";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

import { failureResponse, serveVersionedFile } from "../file-response";
import type { HonoEnv } from "../hono-env";
import {
  findAssetFile,
  imageExtensionOf,
  isAssetName,
  removeAssetFiles,
  writeAssetFile,
} from "./asset-file";
import {
  afterAssetWrite,
  assetOwnerDir,
  assetOwnerIsKnown,
  assetOwnerKey,
  parseAssetOwner,
} from "./asset-owners";
import type { AssetOwner } from "./asset-owners";

/**
 * The request body limit: the file itself is capped at `ASSET_MAX_BYTES`, and the
 * multipart separators, field names, and headers need room too. It applies to this
 * route only, so an RPC body keeps its own budget.
 */
const ASSET_BODY_LIMIT = ASSET_MAX_BYTES * 2;

/** An owner and a base name, parsed once per request. */
type AssetTarget = {
  readonly owner: AssetOwner;
  readonly name: string;
  readonly dir: string;
};

/** Parse the owner and the base name; a bad pair answers `null` for a 400. */
function parseTarget(rawOwner: string, rawName: string): AssetTarget | null {
  const owner = parseAssetOwner(rawOwner);
  if (owner === null || !isAssetName(rawName)) {
    return null;
  }

  return { owner, name: rawName, dir: assetOwnerDir(owner) };
}

/** Register the asset channel. It hangs after authentication, before the RPC fallback. */
export function registerAssetRoutes(app: Hono<HonoEnv>): void {
  app.get("/api/asset", async (c) => {
    const query = new URL(c.req.url).searchParams;
    const target = parseTarget(
      query.get("owner") ?? "",
      query.get("name") ?? ""
    );
    if (target === null) {
      return failureResponse(400, "invalid owner or name");
    }
    if (!(await assetOwnerIsKnown(target.owner))) {
      return failureResponse(404, "owner not found");
    }

    const fileName = findAssetFile(target.dir, target.name);
    if (fileName === null) {
      return failureResponse(404, "asset not found");
    }

    return await serveVersionedFile(
      c.req.raw,
      { primaryDir: target.dir, roots: [target.dir] },
      fileName
    );
  });

  app.post(
    "/api/asset",
    bodyLimit({
      maxSize: ASSET_BODY_LIMIT,
      onError: () => failureResponse(413, "asset too large"),
    }),
    async (c) => {
      const form = await c.req.parseBody();
      const target = parseTarget(
        typeof form.owner === "string" ? form.owner : "",
        typeof form.name === "string" ? form.name : ""
      );
      if (target === null) {
        return failureResponse(400, "invalid owner or name");
      }

      const { file } = form;
      if (!(file instanceof File)) {
        return failureResponse(400, "missing file");
      }
      if (file.size > ASSET_MAX_BYTES) {
        return failureResponse(413, "asset too large");
      }

      const bytes = new Uint8Array(await file.arrayBuffer());
      const extension = imageExtensionOf(bytes);
      if (extension === null) {
        return failureResponse(415, "unsupported media type");
      }

      if (!(await assetOwnerIsKnown(target.owner))) {
        return failureResponse(404, "owner not found");
      }

      const written = writeAssetFile(target.dir, target.name, bytes, extension);
      await afterAssetWrite(target.owner, target.name, written.fileName);

      return c.json({
        owner: assetOwnerKey(target.owner),
        name: target.name,
        path: written.fileName,
        version: written.version,
      });
    }
  );

  app.delete("/api/asset", async (c) => {
    const query = new URL(c.req.url).searchParams;
    const target = parseTarget(
      query.get("owner") ?? "",
      query.get("name") ?? ""
    );
    if (target === null) {
      return failureResponse(400, "invalid owner or name");
    }
    if (!(await assetOwnerIsKnown(target.owner))) {
      return failureResponse(404, "owner not found");
    }

    // Deleting twice is the same request twice: no file still means "it is gone", and
    // the owner's metadata is cleared either way.
    removeAssetFiles(target.dir, target.name);
    await afterAssetWrite(target.owner, target.name, null);

    return c.body(null, 204);
  });
}
