import ultracite from "ultracite/oxfmt";
import core from "ultracite/oxlint/core";
import react from "ultracite/oxlint/react";
import remix from "ultracite/oxlint/remix";
import vitest from "ultracite/oxlint/vitest";
import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    ...ultracite,
  },
  lint: {
    extends: [core, react, remix, vitest],
    options: { typeAware: true, typeCheck: true },
    rules: {
      "promise/avoid-new": "allow",
      "promise/prefer-await-to-callbacks": "allow",
      "promise/prefer-await-to-then": "allow",
    },
  },
  run: {
    cache: false,
  },
  staged: {
    "*": "vp check --fix",
  },
});
