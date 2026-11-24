import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BOT_GLOBAL_MCP_MODES } from "@workspace/agent-client";
import type { BotGlobalMcpMode } from "@workspace/agent-client";
import { Badge } from "@workspace/ui/components/badge";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@workspace/ui/components/segmented-control";
import { Switch } from "@workspace/ui/components/switch";
import { client } from "@workspace/ui/lib/orpc";
import { cn } from "@workspace/ui/lib/utils";
import { Fragment } from "react";
import { useTranslation } from "react-i18next";

import {
  McpServerManager,
  STATUS_DOT,
  STATUS_LABEL_KEY,
} from "../mcp/mcp-server-manager";
import {
  SettingGroup,
  SettingGroupHeader,
  SettingGroupTitle,
  SettingItem,
  SettingItemActions,
  SettingItemContent,
  SettingItemTitle,
  SettingSeparator,
} from "../settings/setting-frame";
import { useBotSettings } from "./bot-settings-context";

export function BotMcpSection() {
  const { bot, isSaving, onUpdate } = useBotSettings();
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const settingsQuery = useQuery({
    queryKey: ["settings"],
    queryFn: async () => await client.setting.get(),
  });

  const statusQuery = useQuery({
    queryKey: ["bot-mcp-status", bot.id],
    queryFn: async () => await client.bot.mcpStatuses({ botId: bot.id }),
    refetchInterval: 15_000,
  });

  const authorizeMutation = useMutation({
    mutationFn: async (id: string) => await client.mcp.authorize({ id }),
    onSuccess: (result) => {
      if (result.url !== undefined) {
        window.open(result.url, "_blank", "noopener,noreferrer");
      }
      void queryClient.invalidateQueries({
        queryKey: ["bot-mcp-status", bot.id],
      });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: async (id: string) => await client.mcp.revoke({ id }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["bot-mcp-status", bot.id],
      });
    },
  });

  const globalServers = settingsQuery.data?.mcpServers ?? [];
  const globalStatuses = statusQuery.data?.globalServers ?? [];
  const selectedIds = new Set(bot.mcp.globalServerIds);

  const inheritedGlobalNames = (
    bot.mcp.globalMode === "all"
      ? globalServers
      : globalServers.filter((server) => selectedIds.has(server.id))
  ).map((server) => server.name);

  const setGlobalMode = (mode: BotGlobalMcpMode) => {
    void onUpdate({
      mcp: { ...bot.mcp, globalMode: mode },
    });
  };

  const toggleGlobalServer = (serverId: string, checked: boolean) => {
    const next = new Set(bot.mcp.globalServerIds);
    if (checked) {
      next.add(serverId);
    } else {
      next.delete(serverId);
    }
    void onUpdate({
      mcp: {
        ...bot.mcp,
        globalMode: "selected",
        globalServerIds: [...next],
      },
    });
  };

  return (
    <div className="mx-auto flex w-2xl flex-col gap-6">
      <div>
        <SettingGroupHeader>
          <SettingGroupTitle>{t("bots.sections.mcp")}</SettingGroupTitle>
        </SettingGroupHeader>

        <SettingGroup>
          <SettingItem variant="muted">
            <SettingItemContent>
              <SettingItemTitle>{t("bots.mcp.globalTitle")}</SettingItemTitle>
            </SettingItemContent>
            <SettingItemActions>
              <SegmentedControl size="sm">
                {BOT_GLOBAL_MCP_MODES.map((mode) => (
                  <SegmentedControlItem
                    key={mode}
                    aria-pressed={bot.mcp.globalMode === mode}
                    data-checked={bot.mcp.globalMode === mode ? "" : undefined}
                    disabled={isSaving}
                    onClick={() => {
                      setGlobalMode(mode);
                    }}
                  >
                    {t(`bots.mcp.modes.${mode}`)}
                  </SegmentedControlItem>
                ))}
              </SegmentedControl>
            </SettingItemActions>
          </SettingItem>

          {bot.mcp.globalMode === "selected" ? (
            <>
              <SettingSeparator />
              {globalServers.length === 0 ? (
                <div className="flex h-16 items-center justify-center text-muted-foreground text-sm">
                  {t("settings.mcp.empty")}
                </div>
              ) : (
                globalServers.map((server, index) => {
                  const status = globalStatuses.find(
                    (row) => row.id === server.id
                  );
                  const label = status?.status ?? "idle";
                  return (
                    <Fragment key={server.id}>
                      {index > 0 ? <SettingSeparator /> : null}
                      <SettingItem variant="muted">
                        <SettingItemContent>
                          <SettingItemTitle>
                            <span
                              className={cn(
                                "size-2 rounded-full",
                                STATUS_DOT[label] ?? STATUS_DOT.idle
                              )}
                            />
                            <span>{server.name}</span>
                            <Badge variant="secondary">
                              {server.transport.type}
                            </Badge>
                            <span className="text-muted-foreground text-xs">
                              {t(STATUS_LABEL_KEY[label])}
                            </span>
                          </SettingItemTitle>
                        </SettingItemContent>
                        <SettingItemActions>
                          <Switch
                            aria-label={server.name}
                            checked={selectedIds.has(server.id)}
                            disabled={isSaving}
                            onCheckedChange={(checked) => {
                              toggleGlobalServer(server.id, checked);
                            }}
                          />
                        </SettingItemActions>
                      </SettingItem>
                    </Fragment>
                  );
                })
              )}
            </>
          ) : null}
        </SettingGroup>
      </div>

      <McpServerManager
        cwdPlaceholder={bot.workspaceDir}
        emptyText={t("bots.mcp.noPrivateServers")}
        isAuthorizing={authorizeMutation.isPending}
        isRevoking={revokeMutation.isPending}
        isSaving={isSaving}
        onAuthorize={async (id) => await authorizeMutation.mutateAsync(id)}
        onRevoke={async (id) => await revokeMutation.mutateAsync(id)}
        onSaveServers={async (nextServers) => {
          await onUpdate({
            mcp: { ...bot.mcp, servers: nextServers },
          });
          void queryClient.invalidateQueries({
            queryKey: ["bot-mcp-status", bot.id],
          });
        }}
        onTestServer={async (server) =>
          await client.bot.testMcp({ botId: bot.id, server })
        }
        servers={bot.mcp.servers}
        statuses={statusQuery.data?.privateServers ?? []}
        takenNames={inheritedGlobalNames}
        title={t("bots.mcp.privateTitle")}
      />
    </div>
  );
}
