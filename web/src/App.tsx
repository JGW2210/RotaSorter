import { useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";
import { Shell } from "./components/Shell";
import { isConfigured, looksLikeServiceKey, missingConfig, supabase } from "./lib/supabase";
import { useUiStore } from "./store/useUiStore";
import Benches from "./screens/Benches";
import BenchDetail from "./screens/BenchDetail";
import Login from "./screens/Login";
import Matrix from "./screens/Matrix";
import RotaBoard from "./screens/RotaBoard";
import RuleBuilder from "./screens/RuleBuilder";
import Rules from "./screens/Rules";
import RunDetail from "./screens/RunDetail";
import Runs from "./screens/Runs";
import Settings from "./screens/Settings";
import StaffDetail from "./screens/StaffDetail";
import StaffList from "./screens/Staff";
import SetupNeeded from "./screens/SetupNeeded";

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [checked, setChecked] = useState(false);
  const density = useUiStore((s) => s.density);

  useEffect(() => {
    document.documentElement.dataset.density = density;
  }, [density]);

  useEffect(() => {
    if (!isConfigured) {
      setChecked(true);
      return;
    }
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setChecked(true);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  if (!isConfigured || looksLikeServiceKey) {
    return <SetupNeeded missing={missingConfig} serviceKeyInBrowser={looksLikeServiceKey} />;
  }

  if (!checked) {
    return (
      <div className="boot">
        <span className="boot__pulse" aria-hidden="true" />
        <p>Checking your session…</p>
      </div>
    );
  }

  if (!session) return <Login />;

  return (
    <Shell session={session}>
      <Routes>
        <Route path="/" element={<Navigate to="/rota" replace />} />
        <Route path="/rota" element={<RotaBoard />} />
        <Route path="/staff" element={<StaffList />} />
        <Route path="/staff/:staffId" element={<StaffDetail />} />
        <Route path="/benches" element={<Benches />} />
        <Route path="/benches/:benchId" element={<BenchDetail />} />
        <Route path="/competency" element={<Matrix />} />
        <Route path="/rules" element={<Rules />} />
        <Route path="/rules/new" element={<RuleBuilder />} />
        <Route path="/rules/:ruleId" element={<RuleBuilder />} />
        <Route path="/runs" element={<Runs />} />
        <Route path="/runs/:runId" element={<RunDetail />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/rota" replace />} />
      </Routes>
    </Shell>
  );
}
