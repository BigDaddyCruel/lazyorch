import { describe, expect, it } from "vitest";
import { PACKAGE_NAME, sharedPlaceholder } from "./index.js";

describe("@lazyorch/shared", () => {
  it("exports package name", () => {
    expect(PACKAGE_NAME).toBe("@lazyorch/shared");
    expect(sharedPlaceholder()).toBe(PACKAGE_NAME);
  });
});
