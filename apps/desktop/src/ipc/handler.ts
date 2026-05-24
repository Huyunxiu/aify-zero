import { RPCHandler } from "@orpc/server/message-port";

import { router } from "./router";

export const rpcHandler = new RPCHandler<Record<never, never>>(router);
