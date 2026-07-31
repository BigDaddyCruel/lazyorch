import { describe, expect, it } from "vitest";
import { discoverBinary, resolveBinary } from "./discover.js";

describe("resolveBinary / discoverBinary", () => {
  it("resolves absolute path when exists() is true", async () => {
    const path = "C:\\Tools\\claude.exe";
    const resolved = await resolveBinary(path, {
      platform: "win32",
      env: { PATH: "", PATHEXT: ".EXE" },
      exists: async (p) => p === path,
    });
    expect(resolved).toBe(path);
  });

  it("returns null when absolute path missing", async () => {
    const resolved = await resolveBinary("/no/such/binary", {
      platform: "linux",
      env: { PATH: "/usr/bin" },
      exists: async () => false,
    });
    expect(resolved).toBeNull();
  });

  it("searches PATH with PATHEXT on win32", async () => {
    const exists = async (p: string): Promise<boolean> =>
      p.replace(/\\/g, "/") === "C:/bin/agy.EXE";
    const resolved = await resolveBinary("agy", {
      platform: "win32",
      env: { PATH: "C:\\bin", PATHEXT: ".EXE;.CMD" },
      exists,
    });
    expect(resolved?.replace(/\\/g, "/")).toBe("C:/bin/agy.EXE");
  });

  it("searches PATH on posix", async () => {
    const resolved = await resolveBinary("claude", {
      platform: "linux",
      env: { PATH: "/usr/local/bin:/usr/bin" },
      exists: async (p) => p === "/usr/local/bin/claude",
    });
    expect(resolved).toBe("/usr/local/bin/claude");
  });

  it("discoverBinary tries candidates in order", async () => {
    const found = await discoverBinary(["missing", "grok", "xai"], {
      platform: "linux",
      env: { PATH: "/opt/bin" },
      exists: async (p) => p === "/opt/bin/grok",
    });
    expect(found).toEqual({
      candidate: "grok",
      binary_path: "/opt/bin/grok",
    });
  });

  it("discoverBinary returns null when none match", async () => {
    const found = await discoverBinary(["a", "b"], {
      platform: "linux",
      env: { PATH: "/bin" },
      exists: async () => false,
    });
    expect(found).toBeNull();
  });

  it("shell name is not resolved as path", async () => {
    expect(await resolveBinary("shell")).toBeNull();
    expect(await resolveBinary("")).toBeNull();
  });
});
