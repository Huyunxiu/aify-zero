import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { client } from "@workspace/ui/lib/orpc";
import { useTranslation } from "react-i18next";

import { McpServerManager } from "../mcp/mcp-server-manager";
import type { McpServerRow } from "../mcp/mcp-server-manager";

export function McpSettings() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const serversQuery = useQuery({
    queryKey: ["settings"],
    queryFn: async () => await client.setting.get(),
    select: (data) => data.mcpServers ?? [],
  });

  const statusQuery = useQuery({
    queryKey: ["mcp-status"],
    queryFn: async () => await client.mcp.statuses(),
    refetchInterval: 15_000,
  });

  const saveMutation = useMutation({
    mutationFn: async (mcpServers: McpServerRow[]) =>
      await client.setting.update({ mcpServers }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
      void queryClient.invalidateQueries({ queryKey: ["mcp-status"] });
    },
  });

  const authorizeMutation = useMutation({
    mutationFn: async (id: string) => await client.mcp.authorize({ id }),
    onSuccess: (result) => {
      if (result.url !== undefined) {
        window.open(result.url, "_blank", "noopener,noreferrer");
      }
      void queryClient.invalidateQueries({ queryKey: ["mcp-status"] });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: async (id: string) => await client.mcp.revoke({ id }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["mcp-status"] });
    },
  });

  return (
    <div className="mx-auto w-2xl">
      <McpServerManager
        isAuthorizing={authorizeMutation.isPending}
        isRevoking={revokeMutation.isPending}
        isSaving={saveMutation.isPending}
        onAuthorize={async (id) => await authorizeMutation.mutateAsync(id)}
        onRevoke={async (id) => await revokeMutation.mutateAsync(id)}
        onSaveServers={async (nextServers) => {
          await saveMutation.mutateAsync(nextServers);
        }}
        onTestServer={async (server) => await client.mcp.test(server)}
        servers={serversQuery.data ?? []}
        statuses={statusQuery.data ?? []}
        title={t("settings.mcp.title")}
      />
    </div>
  );
}
