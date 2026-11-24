import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import type { McpServerStatus } from "@workspace/agent-client";
import {
  isValidMcpServerName,
  mcpAuthType,
  mcpExposureType,
} from "@workspace/agent-client";
import { getErrorMessage } from "@workspace/shared/errors";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@workspace/ui/components/alert-dialog";
import { Badge } from "@workspace/ui/components/badge";
import { Button } from "@workspace/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@workspace/ui/components/field";
import { Input } from "@workspace/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select";
import { Spinner } from "@workspace/ui/components/spinner";
import { Switch } from "@workspace/ui/components/switch";
import { Textarea } from "@workspace/ui/components/textarea";
import type { client } from "@workspace/ui/lib/orpc";
import { cn } from "@workspace/ui/lib/utils";
import {
  ChevronDown,
  KeyRound,
  LogOut,
  Pencil,
  PlugZap,
  PlusIcon,
  Trash,
} from "lucide-react";
import { Fragment, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

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

export type McpServerRow = NonNullable<
  Awaited<ReturnType<typeof client.setting.get>>["mcpServers"]
>[number];

export type McpStatusRow = Awaited<
  ReturnType<typeof client.mcp.statuses>
>[number];

export type McpTestResult = {
  ok: boolean;
  toolCount: number;
  error?: string;
};

type TransportType = "stdio" | "http" | "sse";
type AuthType = "none" | "headers" | "oauth";

function toAuthType(value: string): AuthType {
  if (value === "headers" || value === "oauth") {
    return value;
  }
  return "none";
}

function toTransportType(value: string): TransportType {
  if (value === "http" || value === "sse") {
    return value;
  }
  return "stdio";
}

type McpFormValues = {
  name: string;
  enabled: boolean;
  autoApprove: boolean;
  searchOnDemand: boolean;
  transportType: TransportType;
  command: string;
  args: string;
  env: string;
  cwd: string;
  url: string;
  headers: string;
  authType: AuthType;
};

const EMPTY_FORM: McpFormValues = {
  name: "",
  enabled: true,
  autoApprove: false,
  searchOnDemand: true,
  transportType: "stdio",
  command: "",
  args: "",
  env: "",
  cwd: "",
  url: "",
  headers: "",
  authType: "none",
};

function parsePairs(text: string): Record<string, string> {
  const pairs: Record<string, string> = {};

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }

    const at = line.indexOf("=");
    if (at <= 0) {
      continue;
    }

    pairs[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }

  return pairs;
}

function formatPairs(pairs: Record<string, string> | undefined): string {
  return Object.entries(pairs ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

function toServer(values: McpFormValues, id: string): McpServerRow {
  const base = {
    id,
    name: values.name.trim(),
    enabled: values.enabled,
    autoApprove: values.autoApprove,
    exposure: values.searchOnDemand
      ? ("deferred" as const)
      : ("direct" as const),
  };

  if (values.transportType === "stdio") {
    return {
      ...base,
      transport: {
        type: "stdio",
        command: values.command.trim(),
        args: values.args
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean),
        env: parsePairs(values.env),
        ...(values.cwd.trim() === "" ? {} : { cwd: values.cwd.trim() }),
      },
    };
  }

  return {
    ...base,
    auth: { type: values.authType },
    transport: {
      type: values.transportType,
      url: values.url.trim(),
      headers: values.authType === "headers" ? parsePairs(values.headers) : {},
    },
  };
}

function toForm(server: McpServerRow): McpFormValues {
  const shared = {
    name: server.name,
    enabled: server.enabled ?? true,
    autoApprove: server.autoApprove ?? false,
    searchOnDemand: mcpExposureType(server) === "deferred",
  };

  if (server.transport.type === "stdio") {
    return {
      ...EMPTY_FORM,
      ...shared,
      transportType: "stdio",
      command: server.transport.command,
      args: (server.transport.args ?? []).join("\n"),
      env: formatPairs(server.transport.env),
      cwd: server.transport.cwd ?? "",
    };
  }

  return {
    ...EMPTY_FORM,
    ...shared,
    transportType: server.transport.type,
    url: server.transport.url,
    headers: formatPairs(server.transport.headers),
    authType: mcpAuthType(server),
  };
}

export const STATUS_DOT: Record<McpServerStatus, string> = {
  idle: "bg-muted-foreground/40",
  connecting: "bg-amber-500",
  ready: "bg-emerald-500",
  failed: "bg-destructive",
  "needs-auth": "bg-amber-500",
};

export const STATUS_LABEL_KEY = {
  idle: "settings.mcp.status.idle",
  connecting: "settings.mcp.status.connecting",
  ready: "settings.mcp.status.ready",
  failed: "settings.mcp.status.failed",
  "needs-auth": "settings.mcp.status.needsAuth",
} as const satisfies Record<McpServerStatus, string>;

const MANY_RESIDENT_TOOLS = 50;

export type McpServerManagerProps = {
  title: string;
  servers: readonly McpServerRow[];
  statuses: readonly McpStatusRow[];
  takenNames?: readonly string[];
  cwdPlaceholder?: string;
  emptyText?: string;
  isSaving?: boolean;
  onSaveServers: (nextServers: McpServerRow[]) => Promise<void>;
  onTestServer: (server: McpServerRow) => Promise<McpTestResult>;
  onAuthorize: (id: string) => Promise<unknown>;
  onRevoke: (id: string) => Promise<unknown>;
  isAuthorizing?: boolean;
  isRevoking?: boolean;
};

/**
 * Shared MCP server list, OAuth action menu, and add/edit/test dialog.
 *
 * Reused across global Settings and per-Bot private MCP configuration.
 */
export function McpServerManager({
  title,
  servers,
  statuses,
  takenNames = [],
  cwdPlaceholder,
  emptyText,
  isSaving = false,
  onSaveServers,
  onTestServer,
  onAuthorize,
  onRevoke,
  isAuthorizing = false,
  isRevoking = false,
}: McpServerManagerProps) {
  const { t } = useTranslation();
  const formId = useId();
  const transportItems = useMemo(
    () => [
      { value: "stdio", label: t("settings.mcp.transports.stdio") },
      { value: "http", label: t("settings.mcp.transports.http") },
      { value: "sse", label: t("settings.mcp.transports.sse") },
    ],
    [t]
  );
  const authItems = useMemo(
    () => [
      { value: "none", label: t("settings.mcp.auth.none") },
      { value: "headers", label: t("settings.mcp.auth.headers") },
      { value: "oauth", label: t("settings.mcp.auth.oauth") },
    ],
    [t]
  );
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | undefined>();
  const [testResult, setTestResult] = useState<McpTestResult | undefined>();

  const testMutation = useMutation({
    mutationFn: onTestServer,
    onSuccess: (result) => {
      setTestResult(result);
    },
  });

  const statusOf = (id: string) => statuses.find((row) => row.id === id);

  const form = useForm({
    defaultValues: EMPTY_FORM,
    onSubmit: async ({ value }) => {
      const id = editingId ?? crypto.randomUUID();
      const server = toServer(value, id);

      const next = editingId
        ? servers.map((row) => (row.id === editingId ? server : row))
        : [...servers, server];

      setSaveError(undefined);
      try {
        await onSaveServers(next);
        setDialogOpen(false);
        setEditingId(null);
        setTestResult(undefined);
        form.reset(EMPTY_FORM, { keepDefaultValues: true });
      } catch (error) {
        setSaveError(getErrorMessage(error));
      }
    },
  });

  const openCreate = () => {
    setEditingId(null);
    setTestResult(undefined);
    setSaveError(undefined);
    form.reset(EMPTY_FORM, { keepDefaultValues: true });
    setDialogOpen(true);
  };

  const openEdit = (server: McpServerRow) => {
    setEditingId(server.id);
    setTestResult(undefined);
    setSaveError(undefined);
    form.reset(toForm(server), { keepDefaultValues: true });
    setDialogOpen(true);
  };

  const removeServer = async (id: string) => {
    await onSaveServers(servers.filter((row) => row.id !== id));
    setDeleteTarget(null);
  };

  const runTest = async () => {
    const value = form.state.values;
    await testMutation.mutateAsync(toServer(value, editingId ?? "test"));
  };

  return (
    <div className="flex flex-col">
      <SettingGroupHeader className="flex-row items-center justify-between">
        <SettingGroupTitle className="text-base">{title}</SettingGroupTitle>
        <Button size="sm" onClick={openCreate}>
          <PlusIcon />
          {t("settings.mcp.addServer")}
        </Button>
      </SettingGroupHeader>

      <SettingGroup>
        {servers.length === 0 ? (
          <div className="flex h-20 items-center justify-center text-muted-foreground text-sm">
            {emptyText ?? t("settings.mcp.empty")}
          </div>
        ) : (
          servers.map((server, index) => {
            const status = statusOf(server.id);
            const label: McpServerStatus = status?.status ?? "idle";
            const isOAuth = mcpAuthType(server) === "oauth";

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
                      <span className="font-medium">{server.name}</span>
                      <Badge variant="secondary">{server.transport.type}</Badge>
                    </SettingItemTitle>
                    <div className="flex items-center gap-2 text-muted-foreground text-xs">
                      {status?.toolCount ? (
                        <span>
                          {t("settings.mcp.toolCount", {
                            count: status.toolCount,
                          })}
                          {mcpExposureType(server) === "direct" &&
                          status.toolCount > MANY_RESIDENT_TOOLS ? (
                            <span className="ml-2 text-amber-600">
                              {t("settings.mcp.manyTools")}
                            </span>
                          ) : null}
                        </span>
                      ) : null}

                      {isOAuth ? (
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            render={
                              <Button
                                className="h-7 gap-1 px-2 text-muted-foreground"
                                size="sm"
                                variant="ghost"
                              />
                            }
                          >
                            {status?.toolCount
                              ? t("settings.mcp.authMenu")
                              : t(STATUS_LABEL_KEY[label])}
                            <ChevronDown />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent
                            align="start"
                            className="w-auto min-w-44"
                          >
                            <DropdownMenuItem
                              disabled={isAuthorizing}
                              onClick={() => {
                                void onAuthorize(server.id);
                              }}
                            >
                              <KeyRound />
                              {label === "needs-auth" || !status?.authorized
                                ? t("settings.mcp.authorize")
                                : t("settings.mcp.reauthorize")}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              disabled={!status?.authorized || isRevoking}
                              onClick={() => {
                                void onRevoke(server.id);
                              }}
                            >
                              <LogOut />
                              {t("settings.mcp.revoke")}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      ) : status?.toolCount ? null : (
                        <span>{t(STATUS_LABEL_KEY[label])}</span>
                      )}
                    </div>
                    {status?.error ? (
                      <p className="text-destructive text-xs">{status.error}</p>
                    ) : null}
                  </SettingItemContent>
                  <SettingItemActions>
                    <Switch
                      aria-label={`${t("settings.mcp.enabled")} ${server.name}`}
                      checked={server.enabled ?? true}
                      disabled={isSaving}
                      onCheckedChange={(checked) => {
                        void onSaveServers(
                          servers.map((row) =>
                            row.id === server.id
                              ? { ...row, enabled: checked }
                              : row
                          )
                        );
                      }}
                    />
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      disabled={isSaving}
                      onClick={() => {
                        openEdit(server);
                      }}
                    >
                      <Pencil />
                    </Button>
                    <AlertDialog
                      open={deleteTarget === server.id}
                      onOpenChange={(open) => {
                        setDeleteTarget(open ? server.id : null);
                      }}
                    >
                      <AlertDialogTrigger
                        render={
                          <Button variant="ghost" size="icon-sm">
                            <Trash />
                          </Button>
                        }
                      />
                      <AlertDialogContent size="sm">
                        <AlertDialogHeader>
                          <AlertDialogTitle>
                            {t("settings.mcp.deleteConfirm")}
                          </AlertDialogTitle>
                          <AlertDialogDescription>
                            {t("settings.mcp.deleteDescription", {
                              name: server.name,
                            })}
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>
                            {t("settings.mcp.cancel")}
                          </AlertDialogCancel>
                          <AlertDialogAction
                            variant="destructive"
                            loading={isSaving}
                            disabled={isSaving}
                            onClick={() => {
                              void removeServer(server.id);
                            }}
                          >
                            {t("settings.mcp.delete")}
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </SettingItemActions>
                </SettingItem>
              </Fragment>
            );
          })
        )}
      </SettingGroup>

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) {
            setTestResult(undefined);
            setSaveError(undefined);
          }
        }}
      >
        <DialogContent size="medium">
          <DialogHeader>
            <DialogTitle>
              {editingId
                ? t("settings.mcp.editTitle")
                : t("settings.mcp.createTitle")}
            </DialogTitle>
            <DialogDescription>
              {editingId
                ? t("settings.mcp.editDescription")
                : t("settings.mcp.createDescription")}
            </DialogDescription>
          </DialogHeader>

          <div className="scroll-fade no-scrollbar -mx-4 max-h-[50vh] overflow-y-auto px-4">
            <form
              id={formId}
              onSubmit={(e) => {
                e.preventDefault();
                e.stopPropagation();
                void form.handleSubmit();
              }}
            >
              <FieldGroup>
                <form.Field
                  name="name"
                  validators={{
                    onChange: ({ value }) => {
                      if (!value) {
                        return t("settings.mcp.nameRequired");
                      }
                      if (!isValidMcpServerName(value)) {
                        return t("settings.mcp.nameInvalid");
                      }
                      const taken =
                        servers.some(
                          (row) => row.name === value && row.id !== editingId
                        ) || takenNames.includes(value);
                      return taken ? t("settings.mcp.nameTaken") : undefined;
                    },
                  }}
                >
                  {(field) => {
                    const isInvalid =
                      field.state.meta.isTouched && !field.state.meta.isValid;
                    const errors = field.state.meta.errors.map((message) => ({
                      message,
                    }));
                    return (
                      <Field data-invalid={isInvalid}>
                        <FieldLabel htmlFor={field.name}>
                          {t("settings.mcp.name")}
                        </FieldLabel>
                        <Input
                          id={field.name}
                          name={field.name}
                          value={field.state.value}
                          aria-invalid={isInvalid}
                          placeholder={t("settings.mcp.namePlaceholder")}
                          onBlur={field.handleBlur}
                          onChange={(e) => {
                            field.handleChange(e.target.value.toLowerCase());
                          }}
                        />
                        <FieldDescription>
                          {t("settings.mcp.nameHint")}
                        </FieldDescription>
                        {isInvalid && <FieldError errors={errors} />}
                      </Field>
                    );
                  }}
                </form.Field>

                <form.Field name="transportType">
                  {(field) => (
                    <Field>
                      <FieldLabel htmlFor={field.name}>
                        {t("settings.mcp.transport")}
                      </FieldLabel>
                      <Select
                        items={transportItems}
                        value={field.state.value}
                        onValueChange={(value) => {
                          field.handleChange(toTransportType(value ?? "stdio"));
                        }}
                      >
                        <SelectTrigger id={field.name}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="stdio">
                            {t("settings.mcp.transports.stdio")}
                          </SelectItem>
                          <SelectItem value="http">
                            {t("settings.mcp.transports.http")}
                          </SelectItem>
                          <SelectItem value="sse">
                            {t("settings.mcp.transports.sse")}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </Field>
                  )}
                </form.Field>

                <form.Subscribe
                  selector={(state) => state.values.transportType}
                >
                  {(transportType) =>
                    transportType === "stdio" ? (
                      <>
                        <form.Field
                          name="command"
                          validators={{
                            onChange: ({ value }) =>
                              value
                                ? undefined
                                : t("settings.mcp.commandRequired"),
                          }}
                        >
                          {(field) => {
                            const isInvalid =
                              field.state.meta.isTouched &&
                              !field.state.meta.isValid;
                            const errors = field.state.meta.errors.map(
                              (message) => ({ message })
                            );
                            return (
                              <Field data-invalid={isInvalid}>
                                <FieldLabel htmlFor={field.name}>
                                  {t("settings.mcp.command")}
                                </FieldLabel>
                                <Input
                                  id={field.name}
                                  name={field.name}
                                  value={field.state.value}
                                  aria-invalid={isInvalid}
                                  placeholder={t(
                                    "settings.mcp.commandPlaceholder"
                                  )}
                                  onBlur={field.handleBlur}
                                  onChange={(e) => {
                                    field.handleChange(e.target.value);
                                  }}
                                />
                                {isInvalid && <FieldError errors={errors} />}
                              </Field>
                            );
                          }}
                        </form.Field>

                        <form.Field name="args">
                          {(field) => (
                            <Field>
                              <FieldLabel htmlFor={field.name}>
                                {t("settings.mcp.args")}
                              </FieldLabel>
                              <Textarea
                                id={field.name}
                                name={field.name}
                                value={field.state.value}
                                placeholder={t("settings.mcp.argsPlaceholder")}
                                onBlur={field.handleBlur}
                                onChange={(e) => {
                                  field.handleChange(e.target.value);
                                }}
                              />
                            </Field>
                          )}
                        </form.Field>

                        <form.Field name="env">
                          {(field) => (
                            <Field>
                              <FieldLabel htmlFor={field.name}>
                                {t("settings.mcp.env")}
                              </FieldLabel>
                              <Textarea
                                id={field.name}
                                name={field.name}
                                value={field.state.value}
                                placeholder={t("settings.mcp.envPlaceholder")}
                                onBlur={field.handleBlur}
                                onChange={(e) => {
                                  field.handleChange(e.target.value);
                                }}
                              />
                              <FieldDescription>
                                {t("settings.mcp.envHint")}
                              </FieldDescription>
                            </Field>
                          )}
                        </form.Field>

                        <form.Field name="cwd">
                          {(field) => (
                            <Field>
                              <FieldLabel htmlFor={field.name}>
                                {t("settings.mcp.cwd")}
                              </FieldLabel>
                              <Input
                                id={field.name}
                                name={field.name}
                                value={field.state.value}
                                placeholder={
                                  cwdPlaceholder ??
                                  t("settings.mcp.cwdPlaceholder")
                                }
                                onBlur={field.handleBlur}
                                onChange={(e) => {
                                  field.handleChange(e.target.value);
                                }}
                              />
                            </Field>
                          )}
                        </form.Field>
                      </>
                    ) : (
                      <>
                        <form.Field
                          name="url"
                          validators={{
                            onChange: ({ value }) =>
                              value ? undefined : t("settings.mcp.urlRequired"),
                          }}
                        >
                          {(field) => {
                            const isInvalid =
                              field.state.meta.isTouched &&
                              !field.state.meta.isValid;
                            const errors = field.state.meta.errors.map(
                              (message) => ({ message })
                            );
                            return (
                              <Field data-invalid={isInvalid}>
                                <FieldLabel htmlFor={field.name}>
                                  {t("settings.mcp.url")}
                                </FieldLabel>
                                <Input
                                  id={field.name}
                                  name={field.name}
                                  value={field.state.value}
                                  aria-invalid={isInvalid}
                                  placeholder={t("settings.mcp.urlPlaceholder")}
                                  onBlur={field.handleBlur}
                                  onChange={(e) => {
                                    field.handleChange(e.target.value);
                                  }}
                                />
                                {isInvalid && <FieldError errors={errors} />}
                              </Field>
                            );
                          }}
                        </form.Field>

                        <form.Field name="authType">
                          {(field) => (
                            <Field>
                              <FieldLabel htmlFor={field.name}>
                                {t("settings.mcp.auth.type")}
                              </FieldLabel>
                              <Select
                                items={authItems}
                                value={field.state.value}
                                onValueChange={(value) => {
                                  field.handleChange(
                                    toAuthType(value ?? "none")
                                  );
                                }}
                              >
                                <SelectTrigger id={field.name}>
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="none">
                                    {t("settings.mcp.auth.none")}
                                  </SelectItem>
                                  <SelectItem value="headers">
                                    {t("settings.mcp.auth.headers")}
                                  </SelectItem>
                                  <SelectItem value="oauth">
                                    {t("settings.mcp.auth.oauth")}
                                  </SelectItem>
                                </SelectContent>
                              </Select>
                              <FieldDescription>
                                {field.state.value === "oauth"
                                  ? t("settings.mcp.auth.oauthHint")
                                  : field.state.value === "headers"
                                    ? t("settings.mcp.headersHint")
                                    : t("settings.mcp.auth.noneHint")}
                              </FieldDescription>
                            </Field>
                          )}
                        </form.Field>

                        <form.Subscribe
                          selector={(state) => state.values.authType}
                        >
                          {(authType) =>
                            authType === "headers" ? (
                              <form.Field name="headers">
                                {(field) => (
                                  <Field>
                                    <FieldLabel htmlFor={field.name}>
                                      {t("settings.mcp.headers")}
                                    </FieldLabel>
                                    <Textarea
                                      id={field.name}
                                      name={field.name}
                                      value={field.state.value}
                                      placeholder={t(
                                        "settings.mcp.headersPlaceholder"
                                      )}
                                      onBlur={field.handleBlur}
                                      onChange={(e) => {
                                        field.handleChange(e.target.value);
                                      }}
                                    />
                                  </Field>
                                )}
                              </form.Field>
                            ) : null
                          }
                        </form.Subscribe>
                      </>
                    )
                  }
                </form.Subscribe>

                <form.Field name="enabled">
                  {(field) => (
                    <Field orientation="horizontal">
                      <Switch
                        id={field.name}
                        checked={field.state.value}
                        onCheckedChange={(checked) => {
                          field.handleChange(checked);
                        }}
                      />
                      <FieldLabel htmlFor={field.name}>
                        {t("settings.mcp.enabled")}
                      </FieldLabel>
                    </Field>
                  )}
                </form.Field>

                <form.Field name="autoApprove">
                  {(field) => (
                    <Field orientation="horizontal">
                      <Switch
                        id={field.name}
                        checked={field.state.value}
                        onCheckedChange={(checked) => {
                          field.handleChange(checked);
                        }}
                      />
                      <div>
                        <FieldLabel htmlFor={field.name}>
                          {t("settings.mcp.autoApprove")}
                        </FieldLabel>
                        <FieldDescription>
                          {t("settings.mcp.autoApproveDescription")}
                        </FieldDescription>
                      </div>
                    </Field>
                  )}
                </form.Field>

                <form.Field name="searchOnDemand">
                  {(field) => (
                    <Field orientation="horizontal">
                      <Switch
                        id={field.name}
                        checked={field.state.value}
                        onCheckedChange={(checked) => {
                          field.handleChange(checked);
                        }}
                      />
                      <div>
                        <FieldLabel htmlFor={field.name}>
                          {t("settings.mcp.searchOnDemand")}
                        </FieldLabel>
                        <FieldDescription>
                          {t("settings.mcp.searchOnDemandDescription")}
                        </FieldDescription>
                      </div>
                    </Field>
                  )}
                </form.Field>
              </FieldGroup>
            </form>
          </div>

          {saveError ? (
            <p className="text-destructive text-xs" role="alert">
              {saveError}
            </p>
          ) : null}

          {testResult ? (
            <p
              className={cn(
                "text-xs",
                testResult.ok ? "text-emerald-600" : "text-destructive"
              )}
            >
              {testResult.ok
                ? t("settings.mcp.testOk", { count: testResult.toolCount })
                : t("settings.mcp.testFailed", {
                    error: testResult.error ?? "",
                  })}
            </p>
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={testMutation.isPending}
              onClick={() => {
                void runTest();
              }}
            >
              {testMutation.isPending ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <PlugZap />
              )}
              {t("settings.mcp.test")}
            </Button>
            <DialogClose
              className="min-w-20"
              render={<Button type="button" variant="outline" />}
            >
              {t("settings.mcp.cancel")}
            </DialogClose>
            <form.Subscribe
              selector={(state) =>
                [state.canSubmit, state.isSubmitting] as const
              }
            >
              {([canSubmit, isSubmitting]) => (
                <Button
                  className="min-w-20"
                  type="submit"
                  form={formId}
                  disabled={!canSubmit || isSubmitting}
                >
                  {isSubmitting && <Spinner data-icon="inline-start" />}
                  {editingId
                    ? t("settings.mcp.update")
                    : t("settings.mcp.create")}
                </Button>
              )}
            </form.Subscribe>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
