import { describe, expect, it } from "vitest";

import { isAppUrl } from "../src/app-url";

describe("app document URL", () => {
  it.each([
    "aify-app://app/",
    "aify-app://app",
    "aify-app://app/sessions/1?tab=chat#top",
  ])("accepts %s", (url) => {
    expect(isAppUrl(url)).toBeTruthy();
  });

  it.each([
    "aify-app://other/",
    "aify-app://app:1234/",
    "aify-app://user@app/",
    "aify-app://:secret@app/",
    "http://app/",
    "https://aify-app/",
    "file:///app/",
    "not a url",
  ])("rejects %s", (url) => {
    expect(isAppUrl(url)).toBeFalsy();
  });

  it("does not rely on URL.origin, which is null for custom schemes in Node", () => {
    expect(new URL("aify-app://app/").origin).toBe("null");
    expect(isAppUrl("aify-app://app/")).toBeTruthy();
  });
});
