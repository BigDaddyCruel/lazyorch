import { useState } from "react";
import { DEFAULT_SETTINGS, validateDaemonUrl, type GuiSettings } from "../lib/settings.js";
import { useAppState } from "../state/AppState.js";

export function SettingsPage() {
  const { settings, updateSettings, refresh, connection, health } = useAppState();
  const [draft, setDraft] = useState<GuiSettings>(settings);
  const [saved, setSaved] = useState(false);
  const urlError = validateDaemonUrl(draft.daemonUrl);

  const onSave = () => {
    if (urlError) return;
    updateSettings({
      ...draft,
      daemonUrl: draft.daemonUrl.trim().replace(/\/+$/, ""),
      token: draft.token.trim(),
      pollMs: Math.max(1000, Number(draft.pollMs) || DEFAULT_SETTINGS.pollMs),
    });
    setSaved(true);
    window.setTimeout(() => setSaved(false), 2000);
    void refresh();
  };

  return (
    <div className="stack">
      <section className="card">
        <h3>Daemon connection</h3>
        <p className="muted" style={{ marginTop: 0 }}>
          GUI talks to the user-level daemon over HTTP/SSE only — no orchestration in the Tauri
          shell. Default loopback: <span className="mono">http://127.0.0.1:7420</span>. Browser
          origins require a Bearer token (CSRF mitigation).
        </p>

        <div className="field">
          <label htmlFor="daemonUrl">Daemon URL</label>
          <input
            id="daemonUrl"
            type="text"
            value={draft.daemonUrl}
            onChange={(e) => setDraft((d) => ({ ...d, daemonUrl: e.target.value }))}
            autoComplete="off"
          />
          {urlError && <span className="error">{urlError}</span>}
        </div>

        <div className="field">
          <label htmlFor="token">Bearer token</label>
          <input
            id="token"
            type="password"
            value={draft.token}
            onChange={(e) => setDraft((d) => ({ ...d, token: e.target.value }))}
            placeholder="From ~/.lazyorch/daemon.token"
            autoComplete="off"
          />
        </div>

        <div className="field">
          <label htmlFor="pollMs">Poll interval (ms)</label>
          <input
            id="pollMs"
            type="number"
            min={1000}
            step={500}
            value={draft.pollMs}
            onChange={(e) =>
              setDraft((d) => ({ ...d, pollMs: Number(e.target.value) || d.pollMs }))
            }
          />
        </div>

        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={draft.useDemoFallback}
            onChange={(e) =>
              setDraft((d) => ({ ...d, useDemoFallback: e.target.checked }))
            }
          />
          Use demo board data when daemon has empty/unrich runs
        </label>

        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <button type="button" className="btn primary" disabled={!!urlError} onClick={onSave}>
            Save & reconnect
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => setDraft({ ...DEFAULT_SETTINGS })}
          >
            Reset defaults
          </button>
          {saved && <span className="tag ok">Saved</span>}
        </div>
      </section>

      <section className="card">
        <h3>Status</h3>
        <table className="table">
          <tbody>
            <tr>
              <th>Connection</th>
              <td>{connection}</td>
            </tr>
            <tr>
              <th>Active URL</th>
              <td className="mono">{settings.daemonUrl}</td>
            </tr>
            <tr>
              <th>Health</th>
              <td>
                {health
                  ? `${health.status} (api ${health.api_major}, pid ${health.pid})`
                  : "—"}
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className="card">
        <h3>Environment overrides</h3>
        <ul className="muted">
          <li>
            <span className="mono">VITE_LAZYORCH_URL</span> — default daemon base URL at build time
          </li>
          <li>
            <span className="mono">VITE_LAZYORCH_TOKEN</span> — default Bearer token
          </li>
          <li>
            <span className="mono">VITE_USE_DEMO=0</span> — disable demo fallback by default
          </li>
        </ul>
      </section>
    </div>
  );
}
