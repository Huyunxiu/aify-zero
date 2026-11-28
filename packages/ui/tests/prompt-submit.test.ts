import { describe, expect, test, vi } from "vitest";

import type { PromptDraftSnapshot } from "../src/lib/prompt-submit";
import { submitPromptDraft } from "../src/lib/prompt-submit";

type MockFile = { id: string; url: string };
type MockSource = { id: string; title: string };

interface ComposerState {
  text: string;
  editorDoc: { type: string } | null;
  files: MockFile[];
  sources: MockSource[];
}

const convertFiles = (files: MockFile[]) =>
  Promise.resolve(files.map((file) => ({ url: `data:${file.url}` })));

const createHarness = (initial: Partial<ComposerState> = {}) => {
  const state: ComposerState = {
    text: initial.text ?? "",
    editorDoc: initial.editorDoc ?? null,
    files: initial.files ?? [],
    sources: initial.sources ?? [],
  };
  const disposed: MockFile[][] = [];

  const takeDraft = (): PromptDraftSnapshot<
    MockFile,
    MockSource,
    { type: string }
  > => {
    const snapshot: PromptDraftSnapshot<
      MockFile,
      MockSource,
      { type: string }
    > = {
      text: state.text,
      editorDoc: state.editorDoc,
      files: state.files,
      sources: state.sources,
    };
    state.text = "";
    state.editorDoc = null;
    state.files = [];
    state.sources = [];
    return snapshot;
  };

  const isDraftEmpty = () =>
    state.text === "" && state.files.length === 0 && state.sources.length === 0;

  const restoreDraft = (
    snapshot: PromptDraftSnapshot<MockFile, MockSource, { type: string }>
  ) => {
    state.text = snapshot.text;
    state.editorDoc = snapshot.editorDoc;
    state.files = snapshot.files;
    state.sources = snapshot.sources;
  };

  const disposeFiles = (files: MockFile[]) => {
    disposed.push(files);
  };

  return {
    state,
    disposed,
    takeDraft,
    isDraftEmpty,
    restoreDraft,
    disposeFiles,
    convertFiles,
  };
};

describe(submitPromptDraft, () => {
  test("clears immediately on submit and preserves text typed while in flight", async () => {
    const harness = createHarness({
      text: "First message",
      files: [{ id: "f1", url: "blob:one" }],
    });
    let resolveSubmit!: () => void;
    const submit = vi.fn<
      (payload: { text: string; files: { url: string }[] }) => Promise<void>
    >(
      () =>
        new Promise<void>((resolve) => {
          resolveSubmit = resolve;
        })
    );

    const pending = submitPromptDraft({
      ...harness,
      submit,
    });

    // Draft is cleared synchronously before the async submit settles.
    expect({
      text: harness.state.text,
      files: harness.state.files,
      disposed: harness.disposed,
    }).toStrictEqual({
      text: "",
      files: [],
      disposed: [],
    });

    // User types the next message while the first request is still in flight.
    harness.state.text = "Next message";

    await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce());
    resolveSubmit();
    await pending;

    expect(submit).toHaveBeenCalledWith({
      text: "First message",
      files: [{ url: "data:blob:one" }],
    });
    expect(harness.state.text).toBe("Next message");
    expect(harness.disposed).toStrictEqual([[{ id: "f1", url: "blob:one" }]]);
  });

  test("restores the snapshotted draft on failure when the composer is still empty", async () => {
    const doc = { type: "doc" };
    const files = [{ id: "f1", url: "blob:keep-me" }];
    const sources = [{ id: "s1", title: "Spec" }];
    const harness = createHarness({
      text: "Will fail",
      editorDoc: doc,
      files,
      sources,
    });

    await submitPromptDraft({
      ...harness,
      submit: () => Promise.reject(new Error("network error")),
    });

    expect(harness.state).toStrictEqual({
      text: "Will fail",
      editorDoc: doc,
      files,
      sources,
    });
    expect(harness.disposed).toStrictEqual([]);
  });

  test("does not overwrite a new draft on failure and disposes failed files", async () => {
    const failedFiles = [{ id: "f1", url: "blob:old" }];
    const harness = createHarness({
      text: "First failed",
      files: failedFiles,
    });
    let rejectSubmit!: (error: Error) => void;
    const submit = vi.fn<
      (payload: { text: string; files: { url: string }[] }) => Promise<void>
    >(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectSubmit = reject;
        })
    );

    const pending = submitPromptDraft({
      ...harness,
      submit,
    });

    harness.state.text = "Already typing next";

    await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce());
    rejectSubmit(new Error("boom"));
    await pending;

    expect(harness.state.text).toBe("Already typing next");
    expect(harness.disposed).toStrictEqual([failedFiles]);
  });

  test("disposes snapshotted files on synchronous submit", async () => {
    const files = [{ id: "f1", url: "blob:sync" }];
    const harness = createHarness({
      text: "Sync message",
      files,
    });
    const submit =
      vi.fn<(payload: { text: string; files: { url: string }[] }) => void>();

    await submitPromptDraft({
      ...harness,
      submit,
    });

    expect(submit).toHaveBeenCalledWith({
      text: "Sync message",
      files: [{ url: "data:blob:sync" }],
    });
    expect(harness.state.text).toBe("");
    expect(harness.disposed).toStrictEqual([files]);
  });
});
