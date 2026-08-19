import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ErrorNote, Field, Loading, Panel } from "../components/Bits";
import { useShifts, useSolverSettings } from "../lib/queries";
import { supabase } from "../lib/supabase";
import { useUiStore } from "../store/useUiStore";

export default function Settings() {
  const shifts = useShifts();
  const settings = useSolverSettings();
  const density = useUiStore((s) => s.density);
  const setDensity = useUiStore((s) => s.setDensity);
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState<string | null>(null);

  async function saveSetting(key: string, value: number) {
    setSaving(key);
    await supabase.from("solver_setting").update({ value }).eq("key", key);
    await queryClient.invalidateQueries({ queryKey: ["solver_setting"] });
    setSaving(null);
  }

  if (shifts.error) return <ErrorNote error={shifts.error} />;
  if (shifts.isLoading) return <Loading what="settings" />;

  return (
    <div className="detail">
      <Panel title="Shift definitions">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Name</th>
                <th>Starts</th>
                <th>Ends</th>
                <th>Default</th>
              </tr>
            </thead>
            <tbody>
              {(shifts.data ?? []).map((shift) => (
                <tr key={shift.id}>
                  <td className="mono">{shift.code}</td>
                  <td>{shift.name}</td>
                  <td className="mono">{shift.starts_at.slice(0, 5)}</td>
                  <td className="mono">{shift.ends_at.slice(0, 5)}</td>
                  <td>{shift.is_default ? "Yes" : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted">
          A bench only runs on a shift it has a requirement row for. The prototype
          staffs the Day shift; see <code>docs/ASSUMPTIONS.md</code> for turning the
          Late shift on.
        </p>
      </Panel>

      <Panel title="Solver weights">
        <p className="muted">
          What the solver trades off when more than one rota is legal. Higher costs
          more. Leaving an available person off the rota must cost more than putting
          them on a bench they were already on, or the solver buys variety by benching
          people.
        </p>
        <div className="settings-grid">
          {(settings.data ?? []).map((setting) => (
            <Field key={setting.key} label={setting.label ?? setting.key} hint={setting.description ?? undefined}>
              <input
                type="number"
                defaultValue={setting.value}
                disabled={saving === setting.key}
                onBlur={(e) => {
                  const next = Number(e.target.value);
                  if (next !== setting.value) void saveSetting(setting.key, next);
                }}
              />
            </Field>
          ))}
        </div>
      </Panel>

      <Panel title="Display">
        <Field label="Density" hint="Compact fits the whole week on one screen without scrolling.">
          <select value={density} onChange={(e) => setDensity(e.target.value as "compact" | "comfortable")}>
            <option value="compact">Compact</option>
            <option value="comfortable">Comfortable</option>
          </select>
        </Field>
      </Panel>
    </div>
  );
}
