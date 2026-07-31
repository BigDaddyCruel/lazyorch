import type { ConnectionState } from "../state/AppState.js";

export function ConnectionStatus({
  connection,
  baseUrl,
}: {
  connection: ConnectionState;
  baseUrl: string;
}) {
  const tone =
    connection === "online"
      ? "ok"
      : connection === "connecting"
        ? "info"
        : connection === "unauthorized"
          ? "warn"
          : "err";
  const label =
    connection === "online"
      ? "Daemon online"
      : connection === "connecting"
        ? "Connecting…"
        : connection === "unauthorized"
          ? "Auth required (token)"
          : "Daemon offline";

  return (
    <span className={`pill ${tone}`} title={baseUrl}>
      <span className="dot" />
      {label}
    </span>
  );
}
