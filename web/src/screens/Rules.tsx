import { useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Empty, ErrorNote, Loading, Tag, Toolbar } from "../components/Bits";
import { useAllRuns, useBreaches, useRules, useStaff } from "../lib/queries";
import { ruleToSentence } from "../lib/ruleText";
import { supabase } from "../lib/supabase";
import type { Rule } from "../lib/types";

const ACTION_LABELS: Record<string, string> = {
  must_be_assigned: "Must be assigned",
  cannot_be_assigned: "Cannot be assigned",
  requires_at_least: "Requires at least",
  requires_at_most: "Requires at most",
  requires_supervisor: "Requires supervisor",
  same_bench_all_week: "Same bench all week",
  max_shifts_in_period: "Max shifts",
  not_together: "Never together",
};

export default function Rules() {
  const [params] = useSearchParams();
  const pauseId = params.get("pause");
  const rules = useRules();
  const staff = useStaff();
  const runs = useAllRuns(1);
  const lastRun = runs.data?.[0];
  const breaches = useBreaches(lastRun?.id);
  const queryClient = useQueryClient();

  const nameByCode = useMemo(() => {
    const map = new Map((staff.data ?? []).map((s) => [s.staff_code, s.full_name]));
    return (code: string) => map.get(code) ?? code;
  }, [staff.data]);

  const breachCounts = useMemo(() => {
    const out = new Map<string, number>();
    for (const breach of breaches.data ?? []) {
      if (!breach.rule_id) continue;
      out.set(breach.rule_id, (out.get(breach.rule_id) ?? 0) + 1);
    }
    return out;
  }, [breaches.data]);

  async function toggleStatus(rule: Rule) {
    await supabase
      .from("rule")
      .update({ status: rule.status === "active" ? "paused" : "active" })
      .eq("id", rule.id);
    await queryClient.invalidateQueries({ queryKey: ["rule"] });
  }

  if (rules.error) return <ErrorNote error={rules.error} />;
  if (rules.isLoading) return <Loading what="rules" />;
  if ((rules.data ?? []).length === 0) {
    return (
      <Empty
        title="No rules yet"
        action={
          <Link to="/rules/new" className="btn btn--primary">
            New rule
          </Link>
        }
      >
        Rules are what stop the solver producing a technically valid rota that nobody
        would work.
      </Empty>
    );
  }

  return (
    <>
      <Toolbar>
        <span className="toolbar__count">{rules.data?.length} rules</span>
        {lastRun && (
          <span className="muted">
            Breach counts from the run of {new Date(lastRun.requested_at).toLocaleString("en-GB")}
          </span>
        )}
        <Link to="/rules/new" className="btn btn--primary">
          New rule
        </Link>
      </Toolbar>

      {pauseId && (
        <div className="notice notice--info">
          The infeasibility screen suggested pausing a rule. It is highlighted below.
        </div>
      )}

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              {/* The plain reading is the primary column: nobody scans a list of
                  rule type names and recognises their own rota. */}
              <th>Rule</th>
              <th>Type</th>
              <th>Applies to</th>
              <th>Hard / soft</th>
              <th>Status</th>
              <th>Breaches</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(rules.data ?? []).map((rule) => (
              <tr key={rule.id} className={pauseId === rule.id ? "is-highlighted" : undefined}>
                <td>
                  <Link to={`/rules/${rule.id}`} className="rule-sentence">
                    {rule.plain_english ?? ruleToSentence(rule, { staffName: nameByCode })}
                  </Link>
                  {rule.description && <p className="muted">{rule.description}</p>}
                </td>
                <td>
                  <Tag tone="neutral">{ACTION_LABELS[rule.action] ?? rule.action}</Tag>
                </td>
                <td>{rule.scope}</td>
                <td>
                  {rule.is_hard ? (
                    <Tag tone="accent">Hard</Tag>
                  ) : (
                    <>
                      <Tag tone="caution">Soft</Tag>{" "}
                      <span className="mono">{rule.weight}</span>
                    </>
                  )}
                </td>
                <td>
                  {rule.status === "active" ? (
                    <Tag tone="ok">Active</Tag>
                  ) : (
                    <Tag tone="neutral">Paused</Tag>
                  )}
                </td>
                <td className="mono">{breachCounts.get(rule.id) ?? 0}</td>
                <td>
                  <button type="button" className="btn btn--quiet" onClick={() => void toggleStatus(rule)}>
                    {rule.status === "active" ? "Pause" : "Activate"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
