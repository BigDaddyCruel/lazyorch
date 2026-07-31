import { describe, expect, it } from "vitest";
import {
  isWindowsShellScript,
  quoteWindowsArg,
  resolveSpawnTarget,
} from "./spawn-policy.js";

describe("spawn-policy", () => {
  it("detects shell script extensions on win32 only", () => {
    expect(isWindowsShellScript("x.cmd", "win32")).toBe(true);
    expect(isWindowsShellScript("x.bat", "win32")).toBe(true);
    expect(isWindowsShellScript("x.ps1", "win32")).toBe(true);
    expect(isWindowsShellScript("x.exe", "win32")).toBe(false);
    expect(isWindowsShellScript("x.cmd", "linux")).toBe(false);
  });

  it("quotes Windows args with spaces", () => {
    expect(quoteWindowsArg("a b")).toBe('"a b"');
    expect(quoteWindowsArg('say "hi"')).toBe('"say ""hi"""');
    expect(quoteWindowsArg("plain")).toBe("plain");
  });

  it("routes .cmd through ComSpec", () => {
    const t = resolveSpawnTarget(
      "C:\\Users\\me\\AppData\\Roaming\\npm\\npm.cmd",
      ["--version"],
      { platform: "win32", comspec: "cmd.exe" },
    );
    expect(t.via_comspec).toBe(true);
    expect(t.file).toBe("cmd.exe");
    expect(t.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(t.args[3]).toMatch(/npm\.cmd/);
  });
});
