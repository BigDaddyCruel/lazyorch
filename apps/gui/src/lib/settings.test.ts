import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, validateDaemonUrl } from "./settings.js";

describe("validateDaemonUrl", () => {
  it("accepts loopback http", () => {
    expect(validateDaemonUrl("http://127.0.0.1:7420")).toBeNull();
    expect(validateDaemonUrl(" http://localhost:7420 ")).toBeNull();
  });

  it("rejects empty and bad schemes", () => {
    expect(validateDaemonUrl("")).toBe("Daemon URL is required");
    expect(validateDaemonUrl("ftp://127.0.0.1:7420")).toBe("URL must be http or https");
    expect(validateDaemonUrl("not a url")).toBe("Invalid URL");
  });
});

describe("DEFAULT_SETTINGS", () => {
  it("targets default daemon port", () => {
    expect(DEFAULT_SETTINGS.daemonUrl).toContain("7420");
    expect(DEFAULT_SETTINGS.useDemoFallback).toBe(true);
  });
});
