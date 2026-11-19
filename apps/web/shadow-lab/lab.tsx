/**
 * 阴影对比页：同一组表面，分别用 A（通透）与 B（利落）的尺度渲染。
 * 只在开发时看：入口是 shadow-lab/a.html 与 shadow-lab/b.html。
 */
import type { ReactElement, ReactNode } from "react";

type Variant = "A" | "B" | "Before";
type Theme = "light" | "dark";

const variantCopy: Record<Variant, { name: string; note: string }> = {
  A: {
    name: "A · Airy",
    note: "Each layer has its own alpha; the hue follows the surface.",
  },
  B: {
    name: "B · Crisp",
    note: "Tighter contact, fewer far layers; a harder edge than A.",
  },
  Before: {
    name: "Before",
    note: "The old scale: one colour, every layer at 6%.",
  },
};

function Sample({
  token,
  children,
}: {
  token: string;
  children: ReactNode;
}): ReactElement {
  return (
    <figure className="flex flex-col gap-2">
      <div className="flex min-h-40 items-center justify-center rounded-xl bg-background p-6">
        {children}
      </div>
      <figcaption className="font-mono text-[11px] text-muted-foreground">
        {token}
      </figcaption>
    </figure>
  );
}

function Rows(): ReactElement {
  return (
    <div className="space-y-0.5 text-sm">
      {["Rename", "Copy link", "Move to project"].map((label) => (
        <div
          className="flex items-center justify-between rounded-md px-2 py-1.5"
          key={label}
        >
          <span>{label}</span>
          <span className="text-xs text-muted-foreground">⌘</span>
        </div>
      ))}
      <div className="my-0.5 h-px bg-border" />
      <div className="rounded-md px-2 py-1.5 text-destructive">Delete</div>
    </div>
  );
}

function Samples(): ReactElement {
  return (
    <>
      <Sample token="shadow-2xs">
        <div className="w-full rounded-xl bg-muted p-1">
          <div className="space-y-2 rounded-[10px] bg-background p-3 shadow-2xs">
            <div className="h-2 w-24 rounded-full bg-foreground/15" />
            <div className="h-2 w-40 rounded-full bg-foreground/10" />
          </div>
        </div>
      </Sample>

      <Sample token="shadow-sm/5">
        <div className="flex items-center gap-0.5 rounded-lg bg-muted p-0.5 text-xs">
          <span className="rounded-md bg-background px-3 py-1 shadow-sm/5 dark:bg-input">
            All
          </span>
          <span className="px-3 py-1 text-muted-foreground">Unread</span>
          <span className="px-3 py-1 text-muted-foreground">Archived</span>
        </div>
      </Sample>

      <Sample token="shadow-sm">
        <div className="w-full max-w-64 rounded-lg bg-popover p-2.5 text-sm shadow-sm">
          <div className="font-medium">Rename session</div>
          <p className="mt-1 text-xs text-muted-foreground">
            The new name shows in the sidebar.
          </p>
          <div className="mt-3 flex justify-end gap-2 text-xs">
            <span className="rounded-md px-2 py-1 text-muted-foreground">
              Cancel
            </span>
            <span className="rounded-md bg-primary px-2 py-1 text-primary-foreground">
              Save
            </span>
          </div>
        </div>
      </Sample>

      <Sample token="shadow-md">
        <div className="w-full max-w-56 rounded-lg bg-popover p-1 shadow-md ring-1 ring-foreground/10">
          <Rows />
        </div>
      </Sample>

      <Sample token="shadow-lg">
        <div className="w-full rounded-xl bg-muted p-1 shadow-lg">
          <div className="space-y-2 rounded-[10px] bg-background p-3">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>Changes</span>
              <span>3 files</span>
            </div>
            <div className="h-2 w-32 rounded-full bg-foreground/15" />
            <div className="h-2 w-44 rounded-full bg-foreground/10" />
          </div>
        </div>
      </Sample>

      <Sample token="shadow-lg/5">
        <div className="flex w-full items-center gap-2 rounded-lg border bg-popover px-3 py-2.5 text-sm shadow-lg/5">
          <span className="size-2 rounded-full bg-success" />
          <span className="flex-1">Saved</span>
          <span className="text-xs text-muted-foreground">Undo</span>
        </div>
      </Sample>

      <Sample token="shadow-xl">
        <div className="w-full rounded-xl bg-popover p-4 text-sm shadow-xl ring-1 ring-foreground/10">
          <div className="font-medium">Delete this session?</div>
          <p className="mt-1 text-xs text-muted-foreground">
            The record stays; the row leaves the list.
          </p>
          <div className="mt-4 flex justify-end gap-2 text-xs">
            <span className="rounded-md px-2 py-1 text-muted-foreground">
              Cancel
            </span>
            <span className="rounded-md bg-destructive px-2 py-1 text-white">
              Delete
            </span>
          </div>
        </div>
      </Sample>

      <Sample token="shadow-2xl">
        <div className="w-full rounded-xl bg-popover p-1 shadow-2xl ring-1 ring-foreground/10">
          <div className="m-1 rounded-md border px-2 py-1.5 text-xs text-muted-foreground">
            Search sessions…
          </div>
          <Rows />
        </div>
      </Sample>

      <Sample token="stacked · md over lg">
        <div className="relative flex h-56 w-full items-center justify-center rounded-xl bg-muted shadow-lg">
          <div className="w-56 rounded-lg bg-popover p-1 shadow-md ring-1 ring-foreground/10">
            <Rows />
          </div>
        </div>
      </Sample>
    </>
  );
}

function ThemeColumn({ theme }: { theme: Theme }): ReactElement {
  return (
    <section
      className={
        theme === "dark"
          ? "dark rounded-2xl bg-sidebar p-5 text-foreground"
          : "rounded-2xl bg-sidebar p-5 text-foreground"
      }
    >
      <div className="mb-4 text-xs text-muted-foreground">
        {theme === "dark" ? "Dark" : "Light"}
      </div>
      <div className="grid gap-5 xl:grid-cols-2">
        <Samples />
      </div>
    </section>
  );
}

export function ShadowLab({ variant }: { variant: Variant }): ReactElement {
  return (
    <main className="min-h-screen bg-sidebar px-6 py-8 text-foreground">
      <header className="mb-6 flex flex-wrap items-baseline gap-3">
        <h1 className="text-lg font-medium">{variantCopy[variant].name}</h1>
        <p className="text-sm text-muted-foreground">
          {variantCopy[variant].note}
        </p>
      </header>
      <div className="grid gap-6 xl:grid-cols-2">
        <ThemeColumn theme="light" />
        <ThemeColumn theme="dark" />
      </div>
    </main>
  );
}
