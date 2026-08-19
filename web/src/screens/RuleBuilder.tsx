import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ErrorNote, Loading } from "../components/Bits";
import { GRADE_LABELS, GRADE_ORDER } from "../lib/format";
import {
  useAllRuns,
  useAssignments,
  useBenchGroups,
  useBenches,
  useCompetencyMatrix,
  useRules,
  useShifts,
  useStaff,
} from "../lib/queries";
import { matchesSlot, peopleAffected, type MatchSlot } from "../lib/ruleMatch";
import { ruleToSentence } from "../lib/ruleText";
import { supabase } from "../lib/supabase";
import { isGroup, type RuleAction, type RuleCondition, type RuleGroup, type RuleNode } from "../lib/types";
import { WEEKDAY_NAMES } from "../lib/week";

const SUBJECTS: { value: RuleCondition["subject"]; label: string; operators: string[] }[] = [
  { value: "person", label: "Person", operators: ["is", "is not", "is one of"] },
  { value: "grade", label: "Grade", operators: ["is", "is not"] },
  { value: "competency_level", label: "Competency level", operators: ["is at least", "is"] },
  { value: "day", label: "Day", operators: ["is", "is not", "is one of"] },
  { value: "shift", label: "Shift", operators: ["is", "is not"] },
  { value: "bench", label: "Bench", operators: ["is", "is not", "is in group"] },
  { value: "date", label: "Date", operators: ["before", "after", "between"] },
];

const ACTIONS: { value: RuleAction; label: string; needsN?: boolean }[] = [
  { value: "must_be_assigned", label: "Must be assigned" },
  { value: "cannot_be_assigned", label: "Cannot be assigned" },
  { value: "requires_at_least", label: "Requires at least N people", needsN: true },
  { value: "requires_at_most", label: "Requires at most N people", needsN: true },
  { value: "requires_supervisor", label: "Requires a supervisor present" },
  { value: "same_bench_all_week", label: "Must stay on the same bench all week" },
  { value: "max_shifts_in_period", label: "Maximum shifts in the period", needsN: true },
  { value: "max_consecutive_days", label: "Maximum days in a row", needsN: true },
  { value: "min_days_in_period", label: "Minimum days in the period", needsN: true },
  { value: "not_together", label: "Never rota these together" },
  { value: "must_be_together", label: "Always rota these together" },
];

/* Most rules people write are variations of about eight patterns. Starting
 * from one is faster and less error-prone than building from nothing. */
const PRESETS: { label: string; description: string; build: () => Partial<DraftRule> }[] = [
  {
    label: "Only works certain days",
    description: "Someone who cannot be rota'd outside their days.",
    build: () => ({
      action: "cannot_be_assigned",
      is_hard: true,
      conditions: {
        op: "all",
        children: [
          { subject: "person", operator: "is", values: [] },
          { subject: "day", operator: "is not", values: ["Thursday"] },
        ],
      },
    }),
  },
  {
    label: "Training placement",
    description: "Keep someone on one bench while they work through it.",
    build: () => ({
      action: "same_bench_all_week",
      is_hard: false,
      weight: 70,
      conditions: { op: "all", children: [{ subject: "person", operator: "is", values: [] }] },
    }),
  },
  {
    label: "Needs supervision",
    description: "A bench that is never worked without a trainer on it.",
    build: () => ({
      action: "requires_supervisor",
      is_hard: true,
      params: { supervisor_level: "trainer" },
      conditions: { op: "all", children: [{ subject: "bench", operator: "is", values: [] }] },
    }),
  },
  {
    label: "Keep on one bench all week",
    description: "Continuity for a whole grade or group.",
    build: () => ({
      action: "same_bench_all_week",
      is_hard: false,
      weight: 50,
      conditions: { op: "all", children: [{ subject: "grade", operator: "is", values: [] }] },
    }),
  },
  {
    label: "Never rota these two together",
    description: "Two people who should not share a bench.",
    build: () => ({
      action: "not_together",
      is_hard: true,
      conditions: {
        op: "all",
        children: [{ subject: "person", operator: "is one of", values: [] }],
      },
    }),
  },
  {
    label: "Cap a bench per person",
    description: "Nobody does the heavy bench more than N days.",
    build: () => ({
      action: "max_shifts_in_period",
      is_hard: false,
      weight: 40,
      params: { n: 3 },
      conditions: { op: "all", children: [{ subject: "bench", operator: "is", values: [] }] },
    }),
  },
  {
    label: "Never the same bench two days running",
    description: "Nobody repeats a bench on consecutive days.",
    build: () => ({
      action: "max_consecutive_days",
      is_hard: true,
      params: { n: 1, same_bench: true },
      conditions: { op: "all", children: [] },
    }),
  },
  {
    label: "Rest after a heavy bench",
    description: "Cap how many days in a row anyone does one draining bench.",
    build: () => ({
      action: "max_consecutive_days",
      is_hard: false,
      weight: 60,
      params: { n: 2, same_bench: true },
      conditions: { op: "all", children: [{ subject: "bench", operator: "is", values: [] }] },
    }),
  },
  {
    label: "Guaranteed training days",
    description: "Someone must get at least N days on a bench this week.",
    build: () => ({
      action: "min_days_in_period",
      is_hard: false,
      weight: 80,
      params: { n: 2 },
      conditions: {
        op: "all",
        children: [
          { subject: "person", operator: "is", values: [] },
          { subject: "bench", operator: "is", values: [] },
        ],
      },
    }),
  },
  {
    label: "Keep a trainee with their trainer",
    description: "Two people who share a bench on any day both are in.",
    build: () => ({
      action: "must_be_together",
      is_hard: true,
      conditions: {
        op: "all",
        children: [{ subject: "person", operator: "is one of", values: [] }],
      },
    }),
  },
];

interface DraftRule {
  name: string;
  description: string;
  action: RuleAction;
  params: Record<string, unknown>;
  conditions: RuleGroup;
  is_hard: boolean;
  weight: number;
  scope: "global" | "staff" | "bench";
}

const BLANK: DraftRule = {
  name: "",
  description: "",
  action: "cannot_be_assigned",
  params: {},
  conditions: { op: "all", children: [] },
  is_hard: true,
  weight: 60,
  scope: "global",
};

export default function RuleBuilder() {
  const { ruleId } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const rules = useRules();
  const staff = useStaff();
  const benches = useBenches();
  const groups = useBenchGroups();
  const shifts = useShifts();
  const matrix = useCompetencyMatrix();
  const runs = useAllRuns(1);
  const lastRun = runs.data?.[0];
  const lastAssignments = useAssignments(lastRun?.id);

  const [draft, setDraft] = useState<DraftRule>(BLANK);
  const [showPresets, setShowPresets] = useState(!ruleId);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const existing = rules.data?.find((r) => r.id === ruleId);
  useEffect(() => {
    if (!existing) return;
    setDraft({
      name: existing.name,
      description: existing.description ?? "",
      action: existing.action,
      params: existing.params ?? {},
      conditions: existing.conditions ?? { op: "all", children: [] },
      is_hard: existing.is_hard,
      weight: existing.weight,
      scope: existing.scope,
    });
    setShowPresets(false);
  }, [existing]);

  const nameByCode = useMemo(() => {
    const map = new Map((staff.data ?? []).map((s) => [s.staff_code, s.full_name]));
    return (code: string) => map.get(code) ?? code;
  }, [staff.data]);
  const shiftNameByCode = useMemo(() => {
    const map = new Map((shifts.data ?? []).map((s) => [s.code, s.name]));
    return (code: string) => map.get(code) ?? code;
  }, [shifts.data]);

  const sentence = ruleToSentence(draft, {
    staffName: nameByCode,
    shiftName: shiftNameByCode,
  });

  /* Impact figures come from running the rule against the last completed rota,
   * because a rule nobody can verify is worse than no rule. */
  const impact = useMemo(() => {
    const people = peopleAffected(draft.conditions, staff.data ?? []);
    const benchById = new Map((benches.data ?? []).map((b) => [b.id, b]));
    const staffById = new Map((staff.data ?? []).map((s) => [s.id, s]));
    const groupById = new Map((groups.data ?? []).map((g) => [g.id, g.name]));
    const shiftById = new Map((shifts.data ?? []).map((s) => [s.id, s.code]));

    let matched = 0;
    for (const assignment of lastAssignments.data ?? []) {
      const person = staffById.get(assignment.staff_id);
      const bench = benchById.get(assignment.bench_id);
      if (!person || !bench) continue;
      const slot: MatchSlot = {
        staff: person,
        bench,
        date: assignment.work_date,
        shiftCode: shiftById.get(assignment.shift_id) ?? "",
        groupName: bench.group_id ? groupById.get(bench.group_id) : null,
        competency: (matrix.data ?? []).find(
          (c) => c.staff_id === person.id && c.bench_id === bench.id,
        ),
      };
      if (matchesSlot(draft.conditions, slot)) matched += 1;
    }
    return { people: people.length, matched };
  }, [draft.conditions, staff.data, benches.data, groups.data, shifts.data, matrix.data, lastAssignments.data]);

  function updateNode(path: number[], next: RuleNode | null) {
    setDraft((current) => {
      const clone: RuleGroup = structuredClone(current.conditions);
      let parent: RuleGroup = clone;
      for (const index of path.slice(0, -1)) {
        const child = parent.children[index];
        if (child && isGroup(child)) parent = child;
      }
      const last = path[path.length - 1];
      if (next === null) parent.children.splice(last, 1);
      else parent.children[last] = next;
      return { ...current, conditions: clone };
    });
  }

  function addCondition(path: number[]) {
    setDraft((current) => {
      const clone: RuleGroup = structuredClone(current.conditions);
      let parent: RuleGroup = clone;
      for (const index of path) {
        const child = parent.children[index];
        if (child && isGroup(child)) parent = child;
      }
      parent.children.push({ subject: "person", operator: "is", values: [] });
      return { ...current, conditions: clone };
    });
  }

  function addGroup() {
    setDraft((current) => {
      const clone: RuleGroup = structuredClone(current.conditions);
      clone.children.push({
        op: "any",
        children: [{ subject: "day", operator: "is", values: [] }],
      });
      return { ...current, conditions: clone };
    });
  }

  async function save() {
    setSaving(true);
    setError(null);
    const payload = {
      ...(ruleId ? { id: ruleId } : {}),
      name: draft.name || sentence.slice(0, 60),
      description: draft.description || null,
      action: draft.action,
      params: draft.params,
      conditions: draft.conditions,
      scope: draft.scope,
      is_hard: draft.is_hard,
      weight: draft.weight,
      plain_english: sentence,
    };
    const { error } = await supabase.from("rule").upsert(payload);
    setSaving(false);
    if (error) {
      setError(error.message);
      return;
    }
    await queryClient.invalidateQueries({ queryKey: ["rule"] });
    navigate("/rules");
  }

  async function remove() {
    if (!ruleId) return;
    if (!window.confirm("Delete this rule? Past runs keep the snapshot they solved with.")) {
      return;
    }
    setSaving(true);
    setError(null);
    const { error } = await supabase.from("rule").delete().eq("id", ruleId);
    setSaving(false);
    if (error) {
      setError(error.message);
      return;
    }
    await queryClient.invalidateQueries({ queryKey: ["rule"] });
    navigate("/rules");
  }

  if (rules.isLoading || staff.isLoading) return <Loading what="the builder" />;
  if (rules.error) return <ErrorNote error={rules.error} />;

  const needsN = ACTIONS.find((a) => a.value === draft.action)?.needsN;

  return (
    <div className="builder">
      {showPresets && (
        <div className="builder__presets">
          <h2>Start from a pattern</h2>
          <div className="builder__preset-grid">
            {PRESETS.map((preset) => (
              <button
                key={preset.label}
                type="button"
                className="preset"
                onClick={() => {
                  setDraft({ ...BLANK, ...preset.build(), name: preset.label });
                  setShowPresets(false);
                }}
              >
                <strong>{preset.label}</strong>
                <span>{preset.description}</span>
              </button>
            ))}
            <button
              type="button"
              className="preset preset--blank"
              onClick={() => setShowPresets(false)}
            >
              <strong>Start from nothing</strong>
              <span>Build the condition tree yourself.</span>
            </button>
          </div>
        </div>
      )}

      {!showPresets && (
        <>
          <div className="builder__form">
            <div className="builder__row">
              <span className="builder__keyword">WHEN</span>
              <span className="builder__fixed">Any assignment</span>
            </div>

            <div className="builder__row builder__row--conditions">
              <span className="builder__keyword">IF</span>
              <div className="builder__conditions">
                {draft.conditions.children.length === 0 && (
                  <p className="muted">
                    No conditions: this rule applies to every assignment.
                  </p>
                )}
                {draft.conditions.children.map((node, index) => (
                  <ConditionRow
                    key={index}
                    node={node}
                    first={index === 0}
                    onChange={(next) => updateNode([index], next)}
                    onAddToGroup={() => addCondition([index])}
                    staffOptions={(staff.data ?? []).map((s) => ({
                      value: s.staff_code,
                      label: s.full_name,
                    }))}
                    benchOptions={(benches.data ?? []).map((b) => ({
                      value: b.name,
                      label: b.name,
                    }))}
                    groupOptions={(groups.data ?? []).map((g) => ({
                      value: g.name,
                      label: g.name,
                    }))}
                    shiftOptions={(shifts.data ?? []).map((s) => ({
                      value: s.code,
                      label: s.name,
                    }))}
                  />
                ))}
                <div className="builder__addrow">
                  <button type="button" className="btn btn--quiet" onClick={() => addCondition([])}>
                    + condition
                  </button>
                  <button type="button" className="btn btn--quiet" onClick={addGroup}>
                    + group
                  </button>
                </div>
              </div>
            </div>

            <div className="builder__row">
              <span className="builder__keyword">THEN</span>
              <select
                value={draft.action}
                onChange={(e) =>
                  setDraft({ ...draft, action: e.target.value as RuleAction })
                }
              >
                {ACTIONS.map((action) => (
                  <option key={action.value} value={action.value}>
                    {action.label}
                  </option>
                ))}
              </select>
              {needsN && (
                <input
                  type="number"
                  min={0}
                  className="builder__n"
                  value={Number(draft.params.n ?? 1)}
                  onChange={(e) =>
                    setDraft({ ...draft, params: { ...draft.params, n: Number(e.target.value) } })
                  }
                />
              )}
              {draft.action === "max_consecutive_days" && (
                <select
                  value={draft.params.same_bench === false ? "any" : "same"}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      params: { ...draft.params, same_bench: e.target.value === "same" },
                    })
                  }
                  aria-label="What counts as a repeat"
                >
                  <option value="same">counting the same bench</option>
                  <option value="any">counting any matching bench</option>
                </select>
              )}
              {draft.action === "requires_supervisor" && (
                <select
                  value={String(draft.params.supervisor_level ?? "trainer")}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      params: { ...draft.params, supervisor_level: e.target.value },
                    })
                  }
                >
                  <option value="trainer">Trainer</option>
                  <option value="competent">Competent</option>
                </select>
              )}
            </div>

            <div className="builder__row">
              <span className="builder__keyword">AS</span>
              <label className="radio">
                <input
                  type="radio"
                  checked={draft.is_hard}
                  onChange={() => setDraft({ ...draft, is_hard: true })}
                />
                Hard
              </label>
              <label className="radio">
                <input
                  type="radio"
                  checked={!draft.is_hard}
                  onChange={() => setDraft({ ...draft, is_hard: false })}
                />
                Soft
              </label>
              {!draft.is_hard && (
                <>
                  <input
                    type="range"
                    min={1}
                    max={100}
                    value={draft.weight}
                    onChange={(e) => setDraft({ ...draft, weight: Number(e.target.value) })}
                    aria-label="Weight"
                  />
                  <span className="mono">{draft.weight}</span>
                </>
              )}
            </div>

            <div className="builder__row">
              <span className="builder__keyword">NAME</span>
              <input
                type="text"
                className="builder__name"
                value={draft.name}
                placeholder="Short name for the rules list"
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </div>
          </div>

          {/* Not optional: a visual builder without a live reading produces
              rules people cannot verify. */}
          <aside className="builder__preview">
            <p className="builder__sentence">{sentence || "Nothing to preview yet."}</p>
            <dl className="builder__impact">
              <div>
                <dt>People</dt>
                <dd className="mono">{impact.people}</dd>
              </div>
              <div>
                <dt>Grade filter</dt>
                <dd>
                  {GRADE_ORDER.filter((g) =>
                    JSON.stringify(draft.conditions).includes(`"${g}"`),
                  )
                    .map((g) => GRADE_LABELS[g])
                    .join(", ") || "none"}
                </dd>
              </div>
              <div>
                <dt>In the last rota</dt>
                <dd className="mono">
                  {lastRun ? `${impact.matched} assignments matched` : "no run yet"}
                </dd>
              </div>
            </dl>
            {error && <p className="login__error">{error}</p>}
            <div className="builder__save">
              {ruleId && (
                <button type="button" className="btn btn--quiet" onClick={remove} disabled={saving}>
                  Delete
                </button>
              )}
              <button type="button" className="btn" onClick={() => navigate("/rules")}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn--primary"
                onClick={save}
                disabled={saving || !sentence}
              >
                {saving ? "Saving…" : ruleId ? "Save rule" : "Create rule"}
              </button>
            </div>
          </aside>
        </>
      )}
    </div>
  );
}

interface Option {
  value: string;
  label: string;
}

function ConditionRow({
  node,
  first,
  onChange,
  onAddToGroup,
  staffOptions,
  benchOptions,
  groupOptions,
  shiftOptions,
}: {
  node: RuleNode;
  first: boolean;
  onChange: (next: RuleNode | null) => void;
  onAddToGroup: () => void;
  staffOptions: Option[];
  benchOptions: Option[];
  groupOptions: Option[];
  shiftOptions: Option[];
}) {
  if (isGroup(node)) {
    /* A nested OR renders as an indented card, so nesting is visible rather
       than implied by operator precedence. Two levels is the cap. */
    return (
      <div className="builder__group">
        <div className="builder__group-head">
          <span className="builder__joiner">{first ? "" : "AND"}</span>
          <span className="builder__keyword builder__keyword--sub">ANY OF</span>
          <button type="button" className="btn btn--quiet" onClick={() => onChange(null)}>
            ×
          </button>
        </div>
        {node.children.map((child, index) => (
          <ConditionRow
            key={index}
            node={child}
            first={index === 0}
            onChange={(next) => {
              const children = [...node.children];
              if (next === null) children.splice(index, 1);
              else children[index] = next;
              onChange({ ...node, children });
            }}
            onAddToGroup={onAddToGroup}
            staffOptions={staffOptions}
            benchOptions={benchOptions}
            groupOptions={groupOptions}
            shiftOptions={shiftOptions}
          />
        ))}
        <button type="button" className="btn btn--quiet" onClick={onAddToGroup}>
          + condition
        </button>
      </div>
    );
  }

  const definition = SUBJECTS.find((s) => s.value === node.subject) ?? SUBJECTS[0];
  const multiple = node.operator === "is one of";

  const options: Option[] =
    node.subject === "person"
      ? staffOptions
      : node.subject === "grade"
        ? GRADE_ORDER.map((g) => ({ value: g, label: GRADE_LABELS[g] }))
        : node.subject === "bench"
          ? node.operator === "is in group"
            ? groupOptions
            : benchOptions
          : node.subject === "shift"
            ? shiftOptions
            : node.subject === "day"
              ? WEEKDAY_NAMES.map((d) => ({ value: d, label: d }))
              : node.subject === "competency_level"
                ? [
                    { value: "trainee", label: "Trainee" },
                    { value: "competent", label: "Competent" },
                    { value: "trainer", label: "Trainer" },
                  ]
                : [];

  return (
    <div className="builder__condition">
      <span className="builder__joiner">{first ? "" : "AND"}</span>

      <select
        value={node.subject}
        onChange={(e) => {
          const next = SUBJECTS.find((s) => s.value === e.target.value)!;
          onChange({ subject: next.value, operator: next.operators[0], values: [] });
        }}
      >
        {SUBJECTS.map((subject) => (
          <option key={subject.value} value={subject.value}>
            {subject.label}
          </option>
        ))}
      </select>

      <select
        value={node.operator}
        onChange={(e) => onChange({ ...node, operator: e.target.value, values: node.values })}
      >
        {definition.operators.map((operator) => (
          <option key={operator} value={operator}>
            {operator}
          </option>
        ))}
      </select>

      {node.subject === "date" ? (
        <>
          <input
            type="date"
            value={String(node.values[0] ?? "")}
            onChange={(e) => onChange({ ...node, values: [e.target.value, node.values[1] ?? ""] })}
          />
          {node.operator === "between" && (
            <input
              type="date"
              value={String(node.values[1] ?? "")}
              onChange={(e) => onChange({ ...node, values: [node.values[0] ?? "", e.target.value] })}
            />
          )}
        </>
      ) : (
        <select
          multiple={multiple}
          value={multiple ? node.values.map(String) : String(node.values[0] ?? "")}
          onChange={(e) => {
            const selected = multiple
              ? Array.from(e.target.selectedOptions).map((o) => o.value)
              : [e.target.value];
            onChange({ ...node, values: selected });
          }}
        >
          {!multiple && <option value="">Choose…</option>}
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      )}

      <button
        type="button"
        className="btn btn--quiet"
        onClick={() => onChange(null)}
        aria-label="Remove condition"
      >
        ×
      </button>
    </div>
  );
}
