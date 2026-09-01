import Mention from "@tiptap/extension-mention";
import { Placeholder } from "@tiptap/extensions";
import {
  EditorContent,
  mergeAttributes,
  ReactRenderer,
  useEditor,
} from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";

import "./prompt-input.tiptap.css";
import type {
  SuggestionKeyDownProps,
  SuggestionProps,
} from "@tiptap/suggestion";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

import {
  DropdownMenuGroup,
  DropdownMenuLabel,
} from "../components/dropdown-menu";
import type { client } from "../lib/orpc";
import { cn } from "../lib/utils";
import {
  useOptionalPromptInputController,
  usePromptInputAttachments,
} from "./prompt-input";

const MentionDropdown = forwardRef(
  (props: SuggestionProps<string, { id: string; label: string }>, ref) => {
    const [selectedIndex, setSelectedIndex] = useState(0);

    const selectItem = (index: number) => {
      const item = props.items[index];

      if (item) {
        props.command({ id: item, label: item });
      }
    };

    const upHandler = () => {
      setSelectedIndex(
        (selectedIndex + props.items.length - 1) % props.items.length
      );
    };

    const downHandler = () => {
      setSelectedIndex((selectedIndex + 1) % props.items.length);
    };

    const enterHandler = () => {
      selectItem(selectedIndex);
    };

    useEffect(() => {
      setSelectedIndex(0);
    }, [props.items]);

    useImperativeHandle(ref, () => ({
      onKeyDown: ({ event }: { event: KeyboardEvent }) => {
        if (event.key === "ArrowUp") {
          upHandler();
          return true;
        }

        if (event.key === "ArrowDown") {
          downHandler();
          return true;
        }

        if (event.key === "Enter") {
          enterHandler();
          return true;
        }

        return false;
      },
    }));

    return (
      <div className="z-50 max-h-(--available-height) w-72 min-w-32 origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100 outline-none data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:overflow-hidden data-closed:fade-out-0 data-closed:zoom-out-95">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="font-normal">Skill</DropdownMenuLabel>
          {props.items.length
            ? props.items.map((item, index) => (
                <div
                  data-slot="dropdown-menu-item"
                  className={cn(
                    "group/dropdown-menu-item relative flex cursor-default items-center gap-1.5 rounded-md px-1.5 py-1 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground data-inset:pl-7 data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive dark:data-[variant=destructive]:focus:bg-destructive/20 data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 data-[variant=destructive]:*:[svg]:text-destructive",
                    {
                      "bg-accent text-accent-foreground":
                        index === selectedIndex,
                    }
                  )}
                  key={index}
                  onClick={() => {
                    selectItem(index);
                  }}
                >
                  {item}
                </div>
              ))
            : null}
        </DropdownMenuGroup>
      </div>
    );
  }
);

type SessionResourcesType = NonNullable<
  Awaited<ReturnType<typeof client.session.listSessionResources>>
>;

export type PromptInputTiptapProps = {
  placeholder?: string;
  onEmptyChange?: (isEmpty: boolean) => void;
  resources?: SessionResourcesType;
};

export const PromptInputTiptap = ({
  placeholder = "What would you like to know?",
  onEmptyChange,
  resources,
}: PromptInputTiptapProps) => {
  const controller = useOptionalPromptInputController();
  const attachments = usePromptInputAttachments();
  const [isComposing, setIsComposing] = useState(false);
  const mentionStateRef = useRef(false);
  const resourcesRef = useRef(resources);
  const textValueRef = useRef("");
  const editorRef = controller?.editorRef;

  useEffect(() => {
    resourcesRef.current = resources;
  }, [resources]);

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
      Mention.configure({
        HTMLAttributes: {
          class: cn("mention text-purple-700"),
        },
        deleteTriggerWithBackspace: true,
        renderHTML({ options, node }) {
          return [
            "span",
            mergeAttributes({}, options.HTMLAttributes),
            `${node.attrs.mentionSuggestionChar}skills:${node.attrs.label ?? node.attrs.id}`,
          ];
        },
        renderText({ node }) {
          return `${node.attrs.mentionSuggestionChar}skills:${node.attrs.label ?? node.attrs.id}`;
        },
        suggestions: [
          {
            char: "/",
            placement: "top-start",
            offset: { mainAxis: 8 },
            initialItems: resourcesRef.current?.skills.map((e) => e.name),
            items: ({ query }) => {
              if (!resourcesRef.current?.skills) {
                return [];
              }
              const keyword = query.toLowerCase();
              return resourcesRef.current?.skills
                .map((e) => e.name)
                .filter((e) => e.toLowerCase().includes(keyword));
            },
            render: () => {
              let component: ReactRenderer<unknown, any>;
              let unmount: (() => void) | null = null;

              return {
                onStart(
                  props: SuggestionProps<string, { id: string; label: string }>
                ) {
                  component = new ReactRenderer(MentionDropdown, {
                    props,
                    editor: props.editor,
                  });

                  // The plugin mounts the element, positions it, and keeps it anchored.
                  unmount = props.mount(component.element);
                  mentionStateRef.current = true;
                },
                onUpdate(
                  props: SuggestionProps<string, { id: string; label: string }>
                ) {
                  component.updateProps(props);
                },
                onKeyDown(props: SuggestionKeyDownProps) {
                  if (props.event.key === "Escape") {
                    component.destroy();
                    return true;
                  }
                  const handlers = component.ref as {
                    onKeyDown?: (props: SuggestionKeyDownProps) => boolean;
                  };
                  return handlers.onKeyDown?.(props) ?? false;
                },
                onExit() {
                  unmount?.();
                  component.destroy();
                  mentionStateRef.current = false;
                },
              };
            },
          },
        ],
      }),
    ],
    editorProps: {
      handleKeyDown: (_, event) => handleKeyDown(event),
      attributes: {
        "data-slot": "input-group-control",
        class:
          "w-full outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 rounded-none border-0 bg-transparent shadow-none ring-0 focus-visible:ring-0 disabled:bg-transparent aria-invalid:ring-0 dark:bg-transparent dark:disabled:bg-transparent",
      },
    },
    content: controller?.textInput.value ?? "",
    onUpdate: ({ editor: currentEditor }) => {
      onEmptyChange?.(currentEditor.isEmpty);
      textValueRef.current = currentEditor.getText();
      controller?.textInput.setInput(textValueRef.current);
    },
  });

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // If the external handler prevented default, don't run internal logic
      if (e.defaultPrevented) {
        return;
      }

      if (mentionStateRef.current) {
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

        // Check if the submit button is disabled before submitting
        const form = controller?.formRef.current;
        const submitButton = form?.querySelector(
          'button[type="submit"]'
        ) as HTMLButtonElement | null;
        if (submitButton?.disabled) {
          return;
        }

        form?.requestSubmit();
      }

      // Remove last attachment when Backspace is pressed and textarea is empty
      if (
        e.key === "Backspace" &&
        textValueRef.current === "" &&
        attachments.files.length > 0
      ) {
        e.preventDefault();
        const lastAttachment = attachments.files.at(-1);
        if (lastAttachment) {
          attachments.remove(lastAttachment.id);
        }
        return true;
      }
    },
    [editor, isComposing, attachments, controller?.formRef]
  );

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
