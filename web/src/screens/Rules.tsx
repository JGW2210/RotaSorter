import { useMemo, useState } from "react";
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
  max_consecutive_days: "Max days in a row",
  min_days_in_period: "Min days",
  not_together: "Never together",
  must_be_together: "Always together",
};

type StatusFilter = "all" | "active" | "paused" | "breached";

export default function Rules() {
  const [params] = useSearchParams();
  const pauseId = params.get("pause");
  const rules = useRules();
  const staff = useStaff();
  const runs = useAllRuns(1);
  const lastRun = runs.data?.[0];
  const breaches = useBreaches(lastRun?.id);
  const queryClient = useQueryClient();

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [typeFilter, setTypeFilter] = useState("");

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

  /* Copies arrive paused: a live duplicate would silently double a soft
     rule's weight the moment it lands. */
  async function duplicate(rule: Rule) {
    await supabase.from("rule").insert({
      name: `${rule.name} (copy)`,
      description: rule.description,
      action: rule.action,
      params: rule.params,
      conditions: rule.conditions,
      scope: rule.scope,
      is_hard: rule.is_hard,
      weight: rule.weight,
      status: "paused",
      plain_english: rule.plain_english,
    });
    await queryClient.invalidateQueries({ queryKey: ["rule"] });
  }

  /* The filters answer the questions people actually bring to this list:
     "which rule says…", "what is paused", and "what bit us last run". */
  const visible = (rules.data ?? []).filter((rule) => {
    if (statusFilter === "active" && rule.status !== "active") return false;
    if (statusFilter === "paused" && rule.status !== "paused") return false;
    if (statusFilter === "breached" && !(breachCounts.get(rule.id) ?? 0)) return false;
    if (typeFilter && rule.action !== typeFilter) return false;
    if (search) {
      const haystack =
        `${rule.plain_english ?? ""} ${rule.name} ${rule.description ?? ""}`.toLowerCase();
      if (!haystack.includes(search.toLowerCase())) return false;
    }
    return true;
  });

  const typesPresent = [...new Set((rules.data ?? []).map((r) => r.action))].sort();
  const filtering = Boolean(search || typeFilter || statusFilter !== "all");

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
        <span className="toolbar__count">
          {filtering ? `${visible.length} of ${rules.data?.length}` : rules.data?.length} rules
        </span>
        <input
          type="search"
          className="toolbar__search"
          placeholder="Search rules…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search rules"
        />
        <div className="segmented" role="group" aria-label="Status">
          {(
            [
              ["all", "All"],
              ["active", "Active"],
              ["paused", "Paused"],
              ["breached", "Breached last run"],
            ] as [StatusFilter, string][]
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={statusFilter === value ? "is-active" : ""}
              aria-pressed={statusFilter === value}
              onClick={() => setStatusFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          aria-label="Rule type"
        >
          <option value="">All types</option>
          {typesPresent.map((action) => (
            <option key={action} value={action}>
              {ACTION_LABELS[action] ?? action}
            </option>
          ))}
        </select>
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
            {visible.length === 0 && (
              <tr>
                <td colSpan={7} className="muted">
                  No rules match these filters.
                </td>
              </tr>
            )}
            {visible.map((rule) => (
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
                  <button type="button" className="btn btn--quiet" onClick={() => void duplicate(rule)}>
                    Duplicate
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
