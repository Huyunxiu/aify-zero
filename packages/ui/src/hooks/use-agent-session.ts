import type {
  AgentStreamEvent,
  AgentToolSet,
  AgentTurn,
  InboxItem,
} from "@workspace/agent-client";
import * as React from "react";

import { createSessionClient } from "../lib/session-client";
import type {
  AddToolApprovalResponseOptions,
  SessionClient,
  SessionClientStatus,
  SessionTransport,
  StopOptions,
  SubmitMode,
  SubmitOptions,
  SubmitPayload,
} from "../lib/session-client";

export type {
  AddToolApprovalResponseOptions,
  SessionClientStatus,
  SessionTransport,
  StopOptions,
  SubmitMode,
  SubmitOptions,
  SubmitPayload,
};

export type UseAgentSessionOptions = {
  id: string;
  transport: SessionTransport;
  /** Whether to hydrate turns on mount (`true` by default; `false` for drafts). */
  hydrate?: boolean;
  throttleMs?: number;
  /** Called for every stream event as it arrives, before folding into turns. */
  onEvent?: (event: AgentStreamEvent<AgentToolSet>) => void;
};

export type UseAgentSessionResponse = {
  turns: AgentTurn<AgentToolSet>[];
  pendingMessages: InboxItem[];
  hydrated: boolean;
  submit: (options: SubmitOptions) => Promise<void>;
  sendPending: () => Promise<void>;
  cancelPending: (itemId: string) => Promise<void>;
  clearPending: () => Promise<void>;
  addToolApprovalResponse: (
    options: AddToolApprovalResponseOptions
  ) => Promise<void>;
  stop: (options?: StopOptions) => Promise<void>;
  error: Error | undefined;
  status: SessionClientStatus;
};

/**
 * Thin React binding over {@link createSessionClient}.
 */
export function useAgentSession({
  id,
  transport,
  hydrate = true,
  throttleMs,
  onEvent,
}: UseAgentSessionOptions): UseAgentSessionResponse {
  const clientRef = React.useRef<SessionClient | null>(null);
  const clientIdRef = React.useRef(id);
  const onEventRef = React.useRef(onEvent);
  onEventRef.current = onEvent;

  const emit = React.useCallback((event: AgentStreamEvent<AgentToolSet>) => {
    onEventRef.current?.(event);
  }, []);

  if (clientRef.current === null || clientIdRef.current !== id) {
    clientIdRef.current = id;
    clientRef.current = createSessionClient({
      id,
      transport,
      hydrate,
      throttleMs,
      emit,
    });
  }

  const sessionClient = clientRef.current;

  // Bind connection lifetime to the mounted component; StrictMode unmounts and
  // remounts once in development, so `start` must re-open cleanly after `destroy`.
  React.useEffect(() => {
    sessionClient.start();

    return () => sessionClient.destroy();
  }, [sessionClient]);

  const turns = React.useSyncExternalStore(
    sessionClient.subscribe,
    sessionClient.getTurns,
    sessionClient.getTurns
  );
  const status = React.useSyncExternalStore(
    sessionClient.subscribe,
    sessionClient.getStatus,
    sessionClient.getStatus
  );
  const error = React.useSyncExternalStore(
    sessionClient.subscribe,
    sessionClient.getError,
    sessionClient.getError
  );
  const pendingMessages = React.useSyncExternalStore(
    sessionClient.subscribe,
    sessionClient.getInbox,
    sessionClient.getInbox
  );
  const hydrated = React.useSyncExternalStore(
    sessionClient.subscribe,
    sessionClient.isHydrated,
    sessionClient.isHydrated
  );

  return {
    turns,
    pendingMessages,
    hydrated,
    submit: sessionClient.submit,
    sendPending: sessionClient.sendPending,
    cancelPending: sessionClient.cancelPending,
    clearPending: sessionClient.clearPending,
    addToolApprovalResponse: sessionClient.addToolApprovalResponse,
    stop: sessionClient.stop,
    error,
    status,
  };
}
