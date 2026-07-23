import type { Editor } from "@tiptap/core";
import { Placeholder } from "@tiptap/extensions";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";

import "./prompt-input.tiptap.css";
import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

import type { PromptInputMessage } from "./prompt-input";

export type PromptInputTiptapProps = {
  placeholder?: string;
  onSubmit?: (message: PromptInputMessage) => void;
  editorRef?: RefObject<Editor | null>;
  onEmptyChange?: (isEmpty: boolean) => void;
};

export const PromptInputTiptap = ({
  placeholder = "What would you like to know?",
  onSubmit,
  editorRef,
  onEmptyChange,
}: PromptInputTiptapProps) => {
  const [isComposing, setIsComposing] = useState(false);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // If the external handler prevented default, don't run internal logic
      if (e.defaultPrevented) {
        return;
      }

      if (e.key === "Enter") {
        if (isComposing || e.isComposing) {
          return;
        }
        if (e.shiftKey) {
          return;
        }
        e.preventDefault();

        onSubmit?.({ text: editor.getText(), files: [] });
        return true;
      }
    },
    [onSubmit, isComposing]
  );

  const editor = useEditor({
    // disable Markdown when pasting
    enablePasteRules: false,
    // disable Markdown when typing
    enableInputRules: false,
    extensions: [
      StarterKit,
      Placeholder.configure({
        placeholder,
      }),
    ],
    editorProps: {
      handleKeyDown: (view, event) => handleKeyDown(event),
      attributes: {
        "data-slot": "input-group-control",
        class:
          "w-full outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 rounded-none border-0 bg-transparent shadow-none ring-0 focus-visible:ring-0 disabled:bg-transparent aria-invalid:ring-0 dark:bg-transparent dark:disabled:bg-transparent",
      },
    },
    content: "",
    onUpdate: ({ editor: currentEditor }) => {
      onEmptyChange?.(currentEditor.isEmpty);
    },
  });

  // Sync editor instance out to parent via editorRef, and report initial empty state
  useEffect(() => {
    if (editorRef) {
      editorRef.current = editor;
    }
  }, [editor, editorRef]);

  const handleCompositionEnd = useCallback(() => {
    setIsComposing(false);
  }, []);
  const handleCompositionStart = useCallback(() => {
    setIsComposing(true);
  }, []);

  return (
    <EditorContent
      name="message"
      onCompositionEnd={handleCompositionEnd}
      onCompositionStart={handleCompositionStart}
      // onKeyDown={handleKeyDown}
      className="flex w-full border-input px-2.5 text-base transition-colors outline-none focus-visible:border-ring focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 md:text-sm dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 flex-1 resize-none rounded-none border-0 bg-transparent py-2 shadow-none ring-0 focus-visible:ring-0 disabled:bg-transparent aria-invalid:ring-0 dark:bg-transparent dark:disabled:bg-transparent field-sizing-content max-h-48 min-h-16 overflow-scroll"
      editor={editor}
    />
  );
};
