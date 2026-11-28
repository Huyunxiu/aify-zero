import { ledgerPath, readLedger } from "@workspace/agent";
import z from "zod";

import { getSessionDir } from "../../config";
import { ApiError, ErrorMap } from "../../errors";
import { publicProcedure } from "../../index";
import { SQLiteStore } from "../../storage/sqlite-store";

/**
 * Reads a session's ledger.
 *
 * The replay view is the only reader, and this route is the only way in. It never reads
 * the transcript: a ledger that disagrees with the database is the point of keeping both,
 * and a reader that mixes them cannot say which one it showed.
 *
 * `from` is a line number rather than a byte offset, so a page survives a file that holds a
 * line this build cannot parse.
 */
export const streamSessionLedger = publicProcedure
  .route({ method: "GET", path: "/sessions/{sessionId}/ledger" })
  .errors({ SESSION_NOT_FOUND: ErrorMap.SESSION_NOT_FOUND })
  .input(
    z.object({
      sessionId: z.string(),
      from: z.number().int().positive().optional(),
      limit: z.number().int().positive().max(5000).optional(),
    })
  )
  .handler(async ({ input }) => {
    const store = new SQLiteStore();
    const row = await store.findSessionRow(input.sessionId);
    if (row !== null && row.deletedAt !== null) {
      throw new ApiError("SESSION_NOT_FOUND", {
        data: { sessionId: input.sessionId },
      });
    }

    const path = ledgerPath(getSessionDir(input.sessionId));

    return await readLedger(path, {
      ...(input.from === undefined ? {} : { from: input.from }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    });
  });
