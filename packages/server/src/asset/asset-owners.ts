/**
 * Asset ownership: who owns an asset, where it lives, and whose metadata follows a write.
 *
 * "Static resource" is a rule here, not a directory: an asset sits in its owner's
 * `assets/` and is deleted with that owner. A new owner kind costs one entry in this
 * table; the byte route does not change.
 */
import { ASSET_OWNER_KINDS } from "@workspace/agent-client";
import type { AssetOwnerKind } from "@workspace/agent-client";

import { getBotAssetsDir, getSessionAssetsDir } from "../config";
import { recordBotAvatarPath } from "../routers/bot/bot.avatar";
import { findBotById } from "../routers/bot/bot.repository";

/** The owner of one request: a kind and an id. */
export interface AssetOwner {
  readonly kind: AssetOwnerKind;
  readonly id: string;
}

/**
 * Every owner kind, and the two things it contributes: its directory, and what has to
 * happen after a write. A kind without metadata leaves the second one empty.
 */
const OWNERS: Record<
  AssetOwnerKind,
  {
    readonly dir: (id: string) => string;
    readonly afterWrite: (
      id: string,
      name: string,
      fileName: string | null
    ) => Promise<void>;
  }
> = {
  bot: {
    dir: getBotAssetsDir,
    afterWrite: async (id, name, fileName) => {
      if (name === "avatar") {
        await recordBotAvatarPath(id, fileName);
      }
    },
  },
  session: {
    dir: getSessionAssetsDir,
    afterWrite: async () => {
      // A session owns no metadata about its assets: the file tree is the record.
    },
  },
};

/** An id's character set; neither a Bot id nor a session id needs more. */
const OWNER_ID = /^[a-zA-Z0-9_-]+$/u;

function isOwnerKind(value: string): value is AssetOwnerKind {
  return (ASSET_OWNER_KINDS as readonly string[]).includes(value);
}

/** `bot:<id>` or `session:<id>` to an owner; a malformed string is `null`. */
export function parseAssetOwner(raw: string): AssetOwner | null {
  const parts = raw.split(":");
  if (parts.length !== 2) {
    return null;
  }

  const [kind, id] = parts;
  if (kind === undefined || !isOwnerKind(kind)) {
    return null;
  }
  if (id === undefined || !OWNER_ID.test(id)) {
    return null;
  }

  return { kind, id };
}

/** The canonical spelling of an owner, for responses and logs. */
export function assetOwnerKey(owner: AssetOwner): string {
  return `${owner.kind}:${owner.id}`;
}

/** The asset directory of an owner. */
export function assetOwnerDir(owner: AssetOwner): string {
  return OWNERS[owner.kind].dir(owner.id);
}

/**
 * Whether this owner is one the server can write for.
 *
 * A Bot is a row, so a missing row means no owner. A session is known once it has an
 * id: its file tree is created on demand and there is no row to ask.
 */
export async function assetOwnerIsKnown(owner: AssetOwner): Promise<boolean> {
  return owner.kind === "bot" ? (await findBotById(owner.id)) !== null : true;
}

/** After an asset is written or removed, the owner's own metadata catches up. */
export async function afterAssetWrite(
  owner: AssetOwner,
  name: string,
  fileName: string | null
): Promise<void> {
  await OWNERS[owner.kind].afterWrite(owner.id, name, fileName);
}
