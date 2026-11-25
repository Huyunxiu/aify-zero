import { eventIteratorToUnproxiedDataStream } from "@orpc/client";

import { client } from "./orpc";

/**
 * Reads what happens in this session from now on.
 *
 * The stream is located by session, not by run. A run that is already going
 * replays from its `turn.start`, and every later run goes to the same
 * connection. A session with no run is not an error: the connection waits for
 * its first one.
 *
 * The transcript of a session and the transcript of a subagent read the same
 * stream. The only difference is which component holds it.
 */
export async function openSessionEvents(
  sessionId: string,
  abortSignal: AbortSignal
): Promise<ReadableStream> {
  const stream = await client.session.streamSessionEvents(
    { sessionId },
    { signal: abortSignal }
  );
  return eventIteratorToUnproxiedDataStream(stream);
}
