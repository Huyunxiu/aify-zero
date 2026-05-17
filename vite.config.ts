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
  },
  run: {
    cache: false,
  },
  staged: {
    "*": "vp check --fix",
  },
});
