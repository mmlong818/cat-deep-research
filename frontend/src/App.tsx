import { useState, useEffect } from "react";
import { Redirect, Route, Switch } from "wouter";
import { Toaster } from "sonner";
import Topbar from "./components/Topbar";
import ResearchPage from "./pages/research/ResearchPage";
import { research } from "./lib/api";

export default function App() {
  const [online, setOnline] = useState(false);

  useEffect(() => {
    research.health().then(() => setOnline(true)).catch(() => setOnline(false));
  }, []);

  return (
    <div data-tool="research" style={{ display: "flex", flexDirection: "column", height: "100vh", overflow: "hidden" }}>
      <Toaster position="top-center" />
      <Topbar online={online} />
      <Switch>
        <Route path="/"><Redirect to="/research" /></Route>
        <Route path="/research" component={ResearchPage} />
        <Route>
          <div style={{ display: "flex", height: "100vh", alignItems: "center", justifyContent: "center", color: "var(--text3)" }}>
            404
          </div>
        </Route>
      </Switch>
    </div>
  );
}
