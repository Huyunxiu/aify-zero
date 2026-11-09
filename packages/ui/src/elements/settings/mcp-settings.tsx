import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isValidMcpServerName } from "@workspace/agent/mcp/config";
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
import {
  Table,
  TableBody,
  TableCell,
  TableRow,
} from "@workspace/ui/components/table";
import { Textarea } from "@workspace/ui/components/textarea";
import { client } from "@workspace/ui/lib/orpc";
import { cn } from "@workspace/ui/lib/utils";
import { Pencil, PlusIcon, PlugZap, Trash } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { SettingFrame } from "./setting-frame";

type McpServerRow = NonNullable<
  Awaited<ReturnType<typeof client.setting.get>>["mcpServers"]
>[number];

type TransportType = "stdio" | "http" | "sse";

/** Select 给回来的是字符串，这里收窄成三种传输之一。 */
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
  transportType: TransportType;
  command: string;
  args: string;
  env: string;
  cwd: string;
  url: string;
  headers: string;
};

const EMPTY_FORM: McpFormValues = {
  name: "",
  enabled: true,
  autoApprove: false,
  transportType: "stdio",
  command: "",
  args: "",
  env: "",
  cwd: "",
  url: "",
  headers: "",
};

/** "KEY=VALUE" 每行一条；空行和 `#` 注释忽略。 */
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

/** 表单值还原成一份配置；新增时生成 id。 */
function toServer(values: McpFormValues, id: string): McpServerRow {
  const base = {
    id,
    name: values.name.trim(),
    enabled: values.enabled,
    autoApprove: values.autoApprove,
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
    transport: {
      type: values.transportType,
      url: values.url.trim(),
      headers: parsePairs(values.headers),
    },
  };
}

function toForm(server: McpServerRow): McpFormValues {
  const shared = {
    name: server.name,
    enabled: server.enabled ?? true,
    autoApprove: server.autoApprove ?? false,
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
  };
}

/** 状态点：颜色只说明连通性，文字由 Badge 给。 */
const STATUS_DOT: Record<string, string> = {
  idle: "bg-muted-foreground/40",
  connecting: "bg-amber-500",
  ready: "bg-emerald-500",
  failed: "bg-destructive",
};

export function McpSettings() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<
    { ok: boolean; toolCount: number; error?: string } | undefined
  >();

  const serversQuery = useQuery({
    queryKey: ["settings"],
    queryFn: async () => await client.setting.get(),
    select: (data) => data.mcpServers ?? [],
  });

  const statusQuery = useQuery({
    queryKey: ["mcp-status"],
    queryFn: async () => await client.mcp.statuses(),
    // 连接状态来自服务端，轮询就够了；这里没有推送通道。
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

  const testMutation = useMutation({
    mutationFn: async (server: McpServerRow) => await client.mcp.test(server),
    onSuccess: (result) => {
      setTestResult(result);
    },
  });

  const servers = serversQuery.data ?? [];
  const statuses = statusQuery.data ?? [];

  const statusOf = (id: string) => statuses.find((row) => row.id === id);

  const form = useForm({
    defaultValues: EMPTY_FORM,
    onSubmit: async ({ value }) => {
      const id = editingId ?? crypto.randomUUID();
      const server = toServer(value, id);

      const next = editingId
        ? servers.map((row) => (row.id === editingId ? server : row))
        : [...servers, server];

      await saveMutation.mutateAsync(next);
      setDialogOpen(false);
      setEditingId(null);
      setTestResult(undefined);
      form.reset(EMPTY_FORM, { keepDefaultValues: true });
    },
  });

  const openCreate = () => {
    setEditingId(null);
    setTestResult(undefined);
    form.reset(EMPTY_FORM, { keepDefaultValues: true });
    setDialogOpen(true);
  };

  const openEdit = (server: McpServerRow) => {
    setEditingId(server.id);
    setTestResult(undefined);
    // keepDefaultValues 不能省：useForm 每帧用 `defaultValues` 调一次
    // `update()`，`reset(values)` 会顺手把 defaultValues 改成 values，下一帧
    // 就被改回 EMPTY_FORM —— 编辑弹窗因此是空的。
    form.reset(toForm(server), { keepDefaultValues: true });
    setDialogOpen(true);
  };

  const removeServer = async (id: string) => {
    await saveMutation.mutateAsync(servers.filter((row) => row.id !== id));
    setDeleteTarget(null);
  };

  /** 保存前先试一次；用当前表单值，不落库。 */
  const runTest = async () => {
    const value = form.state.values;
    await testMutation.mutateAsync(toServer(value, editingId ?? "test"));
  };

  return (
    <div className="mx-auto flex w-2xl flex-col">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="font-bold text-xl">{t("settings.mcp.title")}</h1>
          <p className="text-muted-foreground text-sm">
            {t("settings.mcp.description")}
          </p>
        </div>
        <Button size="sm" onClick={openCreate}>
          <PlusIcon />
          {t("settings.mcp.addServer")}
        </Button>
      </div>

      <SettingFrame>
        <Table>
          <TableBody>
            {servers.length === 0 ? (
              <TableRow>
                <TableCell className="h-24 text-center text-muted-foreground">
                  {t("settings.mcp.empty")}
                </TableCell>
              </TableRow>
            ) : (
              servers.map((server) => {
                const status = statusOf(server.id);
                const label = status?.status ?? "idle";

                return (
                  <TableRow key={server.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span
                          className={cn(
                            "size-2 rounded-full",
                            STATUS_DOT[label] ?? STATUS_DOT.idle
                          )}
                        />
                        <span className="font-medium">{server.name}</span>
                        <Badge variant="secondary">
                          {server.transport.type}
                        </Badge>
                      </div>
                      {status?.error ? (
                        <p className="mt-1 text-destructive text-xs">
                          {status.error}
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {status?.toolCount
                        ? t("settings.mcp.toolCount", {
                            count: status.toolCount,
                          })
                        : t(`settings.mcp.status.${label}`)}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-1">
                        <Switch
                          checked={server.enabled ?? true}
                          disabled={saveMutation.isPending}
                          onCheckedChange={(checked) => {
                            void saveMutation.mutateAsync(
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
                          disabled={saveMutation.isPending}
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
                                loading={saveMutation.isPending}
                                disabled={saveMutation.isPending}
                                onClick={() => {
                                  void removeServer(server.id);
                                }}
                              >
                                {t("settings.mcp.delete")}
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </SettingFrame>

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) {
            setTestResult(undefined);
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
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
              id="mcp-server-dialog"
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
                      // 前缀必须唯一，否则两个服务器的工具会互相覆盖。
                      const taken = servers.some(
                        (row) => row.name === value && row.id !== editingId
                      );
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

                {/* 传输方式变了要重画字段：form.state 只是快照，只有
                    Subscribe 才会跟着 store 变。 */}
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
                              !value
                                ? t("settings.mcp.commandRequired")
                                : undefined,
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
                                placeholder={t("settings.mcp.cwdPlaceholder")}
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
                              !value
                                ? t("settings.mcp.urlRequired")
                                : undefined,
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
                              <FieldDescription>
                                {t("settings.mcp.headersHint")}
                              </FieldDescription>
                            </Field>
                          )}
                        </form.Field>
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
              </FieldGroup>
            </form>
          </div>

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
                  form="mcp-server-dialog"
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
