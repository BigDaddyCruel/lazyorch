import { describe, expect, it } from "vitest";
import {
  parseVersionString,
  probeAdapter,
  versionMeetsFloor,
  type ExecImpl,
} from "./probe.js";
import type { AdapterRegistration } from "./types.js";
import { codingCapabilities, shellCapabilities } from "./catalog.js";

function reg(
  overrides: Partial<AdapterRegistration> = {},
): AdapterRegistration {
  return {
    id: "claude",
    display_name: "Claude",
    binary: "claude",
    binary_path: "/usr/bin/claude",
    enabled: true,
    source: "path_discover",
    capabilities: codingCapabilities(),
    version_args: ["--version"],
    ...overrides,
  };
}

describe("parseVersionString / versionMeetsFloor", () => {
  it("extracts semver token", () => {
    expect(parseVersionString("claude 1.2.3 (abc)")).toBe("1.2.3");
    expect(parseVersionString("v2.0")).toBe("2.0");
  });

  it("compares floors", () => {
    expect(versionMeetsFloor("1.2.3", "1.0.0")).toBe(true);
    expect(versionMeetsFloor("1.0.0", "1.2.0")).toBe(false);
    expect(versionMeetsFloor(undefined, "1.0.0")).toBe(false);
    expect(versionMeetsFloor("1.0.0", undefined)).toBe(true);
  });
});

describe("probeAdapter", () => {
  it("shell always ok", async () => {
    const d = await probeAdapter({
      id: "shell",
      display_name: "Shell",
      binary: "shell",
      enabled: true,
      source: "builtin",
      capabilities: shellCapabilities(),
    });
    expect(d.ok).toBe(true);
    expect(d.adapter_id).toBe("shell");
  });

  it("unbound reports unbound", async () => {
    const d = await probeAdapter(
      reg({ unbound: true, binary: "agy", binary_path: undefined }),
    );
    expect(d.ok).toBe(false);
    expect(d.unbound).toBe(true);
  });

  it("uses injected exec for version", async () => {
    const exec: ExecImpl = async () => ({
      code: 0,
      stdout: "claude 9.8.7\n",
      stderr: "",
    });
    const d = await probeAdapter(reg(), { exec });
    expect(d.ok).toBe(true);
    expect(d.version).toBe("9.8.7");
    expect(d.binary_path).toBe("/usr/bin/claude");
  });

  it("fails when version below floor", async () => {
    const exec: ExecImpl = async () => ({
      code: 0,
      stdout: "1.0.0",
      stderr: "",
    });
    const d = await probeAdapter(reg({ version_floor: "2.0.0" }), { exec });
    expect(d.ok).toBe(false);
    expect(d.version).toBe("1.0.0");
    expect(d.message).toMatch(/below floor/);
  });

  it("disabled is ok without exec", async () => {
    const d = await probeAdapter(reg({ enabled: false }));
    expect(d.ok).toBe(true);
    expect(d.message).toMatch(/disabled/);
  });
});
