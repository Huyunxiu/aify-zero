import { createORPCClient } from "@orpc/client";
import type { ClientContext } from "@orpc/client";
import { RPCLink } from "@orpc/client/message-port";
import type { RouterClient } from "@orpc/server";
import { IPC_CHANNELS } from "@workspace/shared/constants";

import type { router } from "./router";

type RPCClient = RouterClient<typeof router>;

class IPCManager {
  private readonly clientPort: MessagePort;
  private readonly serverPort: MessagePort;

  private readonly rpcLink: RPCLink<ClientContext>;

  private initialized = false;

  readonly client: RPCClient;

  constructor() {
    const { port1: clientChannelPort, port2: serverChannelPort } =
      new MessageChannel();
    this.clientPort = clientChannelPort;
    this.serverPort = serverChannelPort;

    this.rpcLink = new RPCLink({
      port: this.clientPort,
    });
    this.client = createORPCClient(this.rpcLink);
  }

  initialize() {
    if (this.initialized) {
      return;
    }

    window.postMessage(IPC_CHANNELS.START_IPC_CLIENT, "*", [this.serverPort]);
    this.clientPort.start();
    this.initialized = true;
  }
}

export const ipc = new IPCManager();
// ipc.initialize();
