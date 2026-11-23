/** A route that covers the session: the session stays alive behind it. */
declare module "@tanstack/router-core" {
  interface StaticDataRouteOption {
    /**
     * Whether the reader can see the session while this route is active.
     *
     * A covering route paints over the session instead of replacing it. The
     * session keeps streaming and keeps its draft; it is only not read, and not
     * reachable by a pointer.
     */
    coversSession?: boolean;
  }
}

/**
 * The one statement a covering route makes. Spelled once so a route cannot
 * misspell the field and still type-check.
 */
export const COVERS_SESSION = { coversSession: true } as const;

type CoveringMatch = {
  readonly staticData?: { readonly coversSession?: boolean };
};

/**
 * Whether a matched route covers the session.
 *
 * The rule lives on the routes that cover, not on the shell that asks: a new
 * section under `/settings` inherits the answer from its layout route.
 */
export const isCoveringMatch = (match: CoveringMatch): boolean =>
  match.staticData?.coversSession === true;
