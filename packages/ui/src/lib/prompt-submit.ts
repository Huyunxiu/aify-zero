export interface PromptDraftSnapshot<TFile, TSource, TDoc = unknown> {
  text: string;
  editorDoc: TDoc | null;
  files: TFile[];
  sources: TSource[];
}

export interface PromptSubmitHost<TFile, TSource, TConverted, TDoc = unknown> {
  takeDraft: () => PromptDraftSnapshot<TFile, TSource, TDoc>;
  isDraftEmpty: () => boolean;
  restoreDraft: (snapshot: PromptDraftSnapshot<TFile, TSource, TDoc>) => void;
  disposeFiles: (files: TFile[]) => void;
  convertFiles: (files: TFile[]) => Promise<TConverted[]>;
  submit: (payload: {
    text: string;
    files: TConverted[];
  }) => void | Promise<void>;
}

/**
 * Hands off the current composer draft before submitting asynchronously.
 *
 * Clearing on submit lets the user type the next message right away without
 * having their new draft wiped when the earlier request settles. On failure,
 * the snapshotted draft is restored only if the composer is still empty.
 */
export const submitPromptDraft = async <
  TFile,
  TSource,
  TConverted,
  TDoc = unknown,
>(
  host: PromptSubmitHost<TFile, TSource, TConverted, TDoc>
): Promise<void> => {
  const snapshot = host.takeDraft();

  try {
    const convertedFiles = await host.convertFiles(snapshot.files);
    await host.submit({ text: snapshot.text, files: convertedFiles });
    host.disposeFiles(snapshot.files);
  } catch {
    if (host.isDraftEmpty()) {
      host.restoreDraft(snapshot);
      return;
    }
    host.disposeFiles(snapshot.files);
  }
};
