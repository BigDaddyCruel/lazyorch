import { describe, expect, it } from "vitest";
import type { DaemonEndpoint } from "@lazyorch/daemon";
import { runServe } from "./serve.js";
import { EXIT } from "../exit-codes.js";

function capture(): {
  stdout: NodeJS.WritableStream & { text: string };
  stderr: NodeJS.WritableStream & { text: string };
} {
  const out = { text: "", write(s: string) { this.text += s; return true; } };
  const err = { text: "", write(s: string) { this.text += s; return true; } };
  return {
    stdout: out as NodeJS.WritableStream & { text: string },
    stderr: err as NodeJS.WritableStream & { text: string },
  };
}

describe("runServe", () => {
  it("ensures daemon via injectable ensure (once)", async () => {
    const streams = capture();
    const ep: DaemonEndpoint = {
      url: "http://127.0.0.1:7420",
      host: "127.0.0.1",
      port: 7420,
      token: "tok",
      started: true,
      pid: 1234,
    };
    const res = await runServe({
      once: true,
      ensure: async () => ep,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });
    expect(res.exitCode).toBe(EXIT.OK);
    expect(res.endpoint?.url).toBe("http://127.0.0.1:7420");
    const body = JSON.parse(streams.stdout.text) as { started: boolean };
    expect(body.started).toBe(true);
  });

  it("background uses spawn mode", async () => {
    const streams = capture();
    let mode: string | undefined;
    await runServe({
      background: true,
      ensure: async (opts) => {
        mode = opts.mode;
        return {
          url: "http://127.0.0.1:7421",
          host: "127.0.0.1",
          port: 7421,
          token: "",
          started: true,
        };
      },
      stdout: streams.stdout,
      stderr: streams.stderr,
    });
    expect(mode).toBe("spawn");
  });

  it("propagates ensure failures", async () => {
    const streams = capture();
    const res = await runServe({
      once: true,
      ensure: async () => {
        throw new Error("lock held");
      },
      stdout: streams.stdout,
      stderr: streams.stderr,
    });
    expect(res.exitCode).toBe(EXIT.ERROR);
    expect(streams.stderr.text).toMatch(/lock held/);
  });
});
