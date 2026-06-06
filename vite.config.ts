import ultracite from "ultracite/oxfmt";
import core from "ultracite/oxlint/core";
import react from "ultracite/oxlint/react";
import remix from "ultracite/oxlint/remix";
import vitest from "ultracite/oxlint/vitest";
import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    ...ultracite,
    ignorePatterns: [
      "packages/ui/src/components/**.tsx",
      "packages/ui/src/elements/prompt-input.tsx",
      "packages/ui/src/elements/message.tsx",
      "packages/ui/src/elements/conversation.tsx",
    ],
  },
  lint: {
    extends: [core, react, remix, vitest],
    ignorePatterns: [
      "packages/ui/src/components/**.tsx",
      "packages/ui/src/elements/prompt-input.tsx",
      "packages/ui/src/elements/message.tsx",
      "packages/ui/src/elements/conversation.tsx",
    ],
    options: { typeAware: true, typeCheck: true },
    rules: {
      "class-methods-use-this": "allow",
      "func-style": "allow",
      "import/no-named-as-default": "allow",
      "max-classes-per-file": "allow",
      "oxc/no-barrel-file": "allow",
      "promise/avoid-new": "allow",
      "promise/prefer-await-to-callbacks": "allow",
      "promise/prefer-await-to-then": "allow",
      "typescript/consistent-type-definitions": "allow",
      "typescript/no-explicit-any": "allow",
      "typescript/no-unsafe-type-assertion": "allow",
      "typescript/strict-boolean-expressions": [
        "error",
        {
          allowNullableBoolean: true,
          allowNullableString: true,
        },
      ],
      "unicorn/no-abusive-eslint-disable": "allow",
      "unicorn/prefer-ternary": "allow",
    },
  },
  run: {
    cache: false,
  },
  staged: {
    "*": "vp check --fix",
  },
});
