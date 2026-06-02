import { os, eventIteratorToUnproxiedDataStream } from "@orpc/server";

import type { Context } from "./context";

export const stream3 = "3";

export const o = os.$context<Context>();

export const publicProcedure = o;

export const stream = eventIteratorToUnproxiedDataStream;

export const stream2 = "2";
