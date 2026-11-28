import { eventIteratorToUnproxiedDataStream } from "@orpc/client";
import type { QueryClient } from "@tanstack/react-query";

import { client, queryClient } from "./orpc";
import type { SessionTransport } from "./session-client";

/** Slice of the oRPC session client required by {@link createOrpcSessionTransport}. */
export type OrpcSessionRpc = Pick<
  typeof client.session,
  | "listSessionTurns"
  | "streamSessionEvents"
  | "createSession"
  | "resumeSession"
  | "stopSession"
  | "listInboxItems"
  | "enqueueInboxItem"
  | "cancelInboxItem"
  | "clearInboxItems"
>;

export type CreateOrpcSessionTransportOptions = {
  rpcClient?: OrpcSessionRpc;
  queryClient?: QueryClient;
  /** When true, omits write capabilities (used by read-only Subagent View). */
  readOnly?: boolean;
};

export const sessionTurnsQueryKey = (sessionId: string) =>
  ["listSessionTurns", sessionId] as const;

/**
 * Production oRPC adapter implementing {@link SessionTransport}.
 *
 * Centralizes QueryClient caching for `listSessionTurns`, cursor forwarding
 * (`since`) for `streamSessionEvents`, and typed `createSession` / `stopSession`
 * / inbox requests.
 */
export function createOrpcSessionTransport(
  options?: CreateOrpcSessionTransportOptions
): SessionTransport {
  const rpcClient = options?.rpcClient ?? client.session;
  const qc = options?.queryClient ?? queryClient;

  const base: SessionTransport = {
    loadTurns: async ({ sessionId }) =>
      await qc.fetchQuery({
        queryKey: sessionTurnsQueryKey(sessionId),
        queryFn: async ({ signal }) =>
          await rpcClient.listSessionTurns({ sessionId }, { signal }),
      }),
    openEvents: async ({ sessionId, since, abortSignal }) => {
      const stream = await rpcClient.streamSessionEvents(
        {
          sessionId,
          ...(since === undefined ? {} : { since }),
        },
        { signal: abortSignal }
      );
      return eventIteratorToUnproxiedDataStream(stream);
    },
  };

  if (options?.readOnly === true) {
    return base;
  }

  return {
    ...base,
    write: {
      send: async ({ sessionId, turns, abortSignal, approvals, payload }) => {
        await rpcClient.createSession(
          {
            sessionId,
            turns: approvals?.length ? [] : turns.slice(-1),
            model: payload.model,
            ...(payload.modelEffort === undefined
              ? {}
              : { modelEffort: payload.modelEffort }),
            ...(payload.botId === undefined ? {} : { botId: payload.botId }),
            ...(payload.projectId === undefined
              ? {}
              : { projectId: payload.projectId }),
            ...(payload.approvalPolicy === undefined
              ? {}
              : { approvalPolicy: payload.approvalPolicy }),
            ...(approvals === undefined ? {} : { approvals }),
          },
          { signal: abortSignal }
        );
      },
      resume: async ({ sessionId }) =>
        await rpcClient.resumeSession({ sessionId }),
      stop: async ({ sessionId, keepSubagents }) =>
        await rpcClient.stopSession({
          sessionId,
          ...(keepSubagents === true ? { keepSubagents: true } : {}),
        }),
      inbox: {
        list: async ({ sessionId }) => {
          const result = await rpcClient.listInboxItems({ sessionId });
          return result.items;
        },
        enqueue: async (input) => await rpcClient.enqueueInboxItem(input),
        cancel: async ({ sessionId, itemId }) =>
          await rpcClient.cancelInboxItem({ sessionId, itemId }),
        clear: async ({ sessionId }) =>
          await rpcClient.clearInboxItems({ sessionId }),
      },
    },
  };
}

/** Shared production transport for interactive Session views. */
export const orpcSessionTransport = createOrpcSessionTransport();

/** Shared production transport for read-only Subagent View transcripts. */
export const orpcReadOnlySessionTransport = createOrpcSessionTransport({
  readOnly: true,
});
