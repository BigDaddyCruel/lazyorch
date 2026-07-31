const STORAGE_KEY = "lazyorch.gui.settings.v1";

export interface GuiSettings {
  daemonUrl: string;
  token: string;
  useDemoFallback: boolean;
  pollMs: number;
}

export const DEFAULT_SETTINGS: GuiSettings = {
  daemonUrl: "http://127.0.0.1:7420",
  token: "",
  useDemoFallback: true,
  pollMs: 5000,
};

export function loadSettings(): GuiSettings {
  if (typeof localStorage === "undefined") {
    return { ...DEFAULT_SETTINGS };
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<GuiSettings>;
    return {
      daemonUrl:
        typeof parsed.daemonUrl === "string" && parsed.daemonUrl.trim()
          ? parsed.daemonUrl.trim()
          : DEFAULT_SETTINGS.daemonUrl,
      token: typeof parsed.token === "string" ? parsed.token : "",
      useDemoFallback:
        typeof parsed.useDemoFallback === "boolean"
          ? parsed.useDemoFallback
          : DEFAULT_SETTINGS.useDemoFallback,
      pollMs:
        typeof parsed.pollMs === "number" && parsed.pollMs >= 1000
          ? parsed.pollMs
          : DEFAULT_SETTINGS.pollMs,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: GuiSettings): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

export function validateDaemonUrl(url: string): string | null {
  const t = url.trim();
  if (!t) return "Daemon URL is required";
  try {
    const u = new URL(t);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return "URL must be http or https";
    }
    return null;
  } catch {
    return "Invalid URL";
  }
}
