import { Layout } from "./components/Layout.js";
import { AgentsPage } from "./pages/Agents.js";
import { HomePage } from "./pages/Home.js";
import { LogsPage } from "./pages/Logs.js";
import { PlanPage } from "./pages/Plan.js";
import { RunBoardPage } from "./pages/RunBoard.js";
import { SettingsPage } from "./pages/Settings.js";
import { AppStateProvider, useAppState } from "./state/AppState.js";

function Router() {
  const { page } = useAppState();
  switch (page) {
    case "board":
      return <RunBoardPage />;
    case "plan":
      return <PlanPage />;
    case "agents":
      return <AgentsPage />;
    case "logs":
      return <LogsPage />;
    case "settings":
      return <SettingsPage />;
    case "home":
    default:
      return <HomePage />;
  }
}

export function App() {
  return (
    <AppStateProvider>
      <Layout>
        <Router />
      </Layout>
    </AppStateProvider>
  );
}
