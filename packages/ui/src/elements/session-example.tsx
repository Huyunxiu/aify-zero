import { MessageSquareIcon } from "lucide-react";
import { nanoid } from "nanoid";
import { useEffect, useState } from "react";

import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "./conversation";
import { Message, MessageContent } from "./message";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "./prompt-input";
import type { PromptInputMessage } from "./prompt-input";
import { TitleBar } from "./title-bar";

const messages: {
  key: string;
  content: string;
  role: "user" | "assistant";
}[] = [
  {
    content: "Hello, how are you?",
    key: nanoid(),
    role: "user",
  },
  {
    content: "I'm good, thank you! How can I assist you today?",
    key: nanoid(),
    role: "assistant",
  },
  {
    content: "I'm looking for information about your services.",
    key: nanoid(),
    role: "user",
  },
  {
    content:
      "Sure! We offer a variety of AI solutions. What are you interested in?",
    key: nanoid(),
    role: "assistant",
  },
  {
    content: "I'm interested in natural language processing tools.",
    key: nanoid(),
    role: "user",
  },
  {
    content: "Great choice! We have several NLP APIs. Would you like a demo?",
    key: nanoid(),
    role: "assistant",
  },
  {
    content: "Yes, a demo would be helpful.",
    key: nanoid(),
    role: "user",
  },
  {
    content: "Alright, I can show you a sentiment analysis example. Ready?",
    key: nanoid(),
    role: "assistant",
  },
  {
    content: "Yes, please proceed.",
    key: nanoid(),
    role: "user",
  },
  {
    content: "Here is a sample: 'I love this product!' → Positive sentiment.",
    key: nanoid(),
    role: "assistant",
  },
  {
    content: "Impressive! Can it handle multiple languages?",
    key: nanoid(),
    role: "user",
  },
  {
    content: "Absolutely, our models support over 20 languages.",
    key: nanoid(),
    role: "assistant",
  },
  {
    content: "How do I get started with the API?",
    key: nanoid(),
    role: "user",
  },
  {
    content: "You can sign up on our website and get an API key instantly.",
    key: nanoid(),
    role: "assistant",
  },
  {
    content: "Is there a free trial available?",
    key: nanoid(),
    role: "user",
  },
  {
    content: "Yes, we offer a 14-day free trial with full access.",
    key: nanoid(),
    role: "assistant",
  },
  {
    content: "What kind of support do you provide?",
    key: nanoid(),
    role: "user",
  },
  {
    content: "We provide 24/7 chat and email support for all users.",
    key: nanoid(),
    role: "assistant",
  },
  {
    content: "Thank you for the information!",
    key: nanoid(),
    role: "user",
  },
  {
    content: "You're welcome! Let me know if you have any more questions.",
    key: nanoid(),
    role: "assistant",
  },
];

type SessionExampleProps = React.ComponentProps<"div">;

function SessionExample() {
  const [visibleMessages, setVisibleMessages] = useState<
    {
      key: string;
      content: string;
      role: "user" | "assistant";
    }[]
  >([]);

  useEffect(() => {
    let currentIndex = 0;
    const interval = setInterval(() => {
      if (currentIndex < messages.length && messages[currentIndex]) {
        const currentMessage = messages[currentIndex];
        if (currentMessage) {
          setVisibleMessages((prev) => [
            ...prev,
            {
              content: currentMessage.content,
              key: currentMessage.key,
              role: currentMessage.role,
            },
          ]);
        }
        currentIndex += 1;
      } else {
        clearInterval(interval);
      }
    }, 500);

    return () => {
      clearInterval(interval);
    };
  }, []);

  const handleSubmit = (message: PromptInputMessage) => {
    console.log("handleSubmit", visibleMessages, message);
  };

  return (
    <div className="flex h-dvh w-full flex-row overflow-hidden">
      <div className="flex min-w-0 flex-col w-full">
        {/* session header */}
        <TitleBar className="sticky top-0 flex h-14 items-center gap-2 bg-sidebar px-3" />
        {/* session container */}
        <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
          {/* session content */}
          <div className="relative flex-1 bg-background">
            <div className="absolute inset-0 touch-pan-y overflow-y-auto bg-transparent">
              <Conversation className="relative size-full mx-auto flex min-h-full min-w-0 max-w-4xl flex-col gap-5 py-6 md:gap-7">
                <ConversationContent>
                  {visibleMessages.length === 0 ? (
                    <ConversationEmptyState
                      description="Messages will appear here as the conversation progresses."
                      icon={<MessageSquareIcon className="size-6" />}
                      title="Start a conversation"
                    />
                  ) : (
                    visibleMessages.map(({ key, content, role }) => (
                      <Message from={role} key={key}>
                        <MessageContent>{content}</MessageContent>
                      </Message>
                    ))
                  )}
                </ConversationContent>
                <ConversationScrollButton />
              </Conversation>
            </div>
          </div>

          {/* session input */}
          <div className="sticky bottom-0 z-1 mx-auto flex w-full max-w-4xl gap-2 border-t-0 bg-background px-2 py-3 pt-1 md:px-4 md:pb-4">
            <PromptInput onSubmit={handleSubmit}>
              <PromptInputBody>
                <PromptInputTextarea />
              </PromptInputBody>
              <PromptInputFooter>
                <PromptInputTools></PromptInputTools>
                <PromptInputSubmit />
              </PromptInputFooter>
            </PromptInput>
          </div>
        </div>
      </div>
    </div>
  );
}

export type { SessionExampleProps };
export { SessionExample };
