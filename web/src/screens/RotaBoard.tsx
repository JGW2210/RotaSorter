import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CoverageRail } from "../components/CoverageRail";
import { Chip } from "../components/Chip";
import { Empty, ErrorNote, Loading, Tag } from "../components/Bits";
import { InfeasiblePanel } from "../components/InfeasiblePanel";
import { SolveStatus } from "../components/SolveStatus";
import { coverageFor, isGap, requirementFor, summariseWeek } from "../lib/coverage";
import { checkDrop, isSignedOff, type DropVerdict } from "../lib/eligibility";
import { GRADE_LABELS } from "../lib/format";
import { benchDayKey, pivotByBenchDay, pivotByStaffDay, staffDayKey } from "../lib/pivot";
import {
  useAbsences,
  useAssignments,
  useAvailability,
  useBenchGroups,
  useBenchRequirements,
  useBenches,
  useBreaches,
  useCompetencyMatrix,
  usePins,
  usePriorWeekHistory,
  usePublishedWeek,
  useRules,
  useShifts,
  useSolverSettings,
  useStaff,
  useWeekRuns,
} from "../lib/queries";
import { buildProblem } from "../lib/buildProblem";
import { persistRun } from "../lib/persistRun";
import { SolveCancelled, solveInWorker, warmSolver } from "../solver";
import { supabase } from "../lib/supabase";
import type { Assignment, Bench, Staff } from "../lib/types";
import { dayShort, formatDateShort, isWeekend, weekDates } from "../lib/week";
import { useUiStore } from "../store/useUiStore";

interface DragPayload {
  staffId: string;
  fromBenchId?: string;
  fromDate?: string;
}

export default function RotaBoard() {
  const weekStart = useUiStore((s) => s.weekStart);
  const view = useUiStore((s) => s.view);
  const setView = useUiStore((s) => s.setView);
  const { shiftId, groupId, gapsOnly, selection, select, setFilter, clearFilters } =
    useUiStore();
  const pinsPanelOpen = useUiStore((s) => s.pinsPanelOpen);
  const setPinsPanelOpen = useUiStore((s) => s.setPinsPanelOpen);
  const queryClient = useQueryClient();

  const shifts = useShifts();
  const benches = useBenches();
  const groups = useBenchGroups();
  const requirements = useBenchRequirements();
  const staff = useStaff();
  const matrix = useCompetencyMatrix();
  const availability = useAvailability();
  const absences = useAbsences();
  const runs = useWeekRuns(weekStart);
  const pins = usePins(weekStart);
  const priorHistory = usePriorWeekHistory(weekStart);
  const published = usePublishedWeek(weekStart);
  const rules = useRules();
  const solverSettings = useSolverSettings();

  const latestRun = runs.data?.[0] ?? null;
  const assignments = useAssignments(latestRun?.id);
  const breaches = useBreaches(latestRun?.id);

  const [busy, setBusy] = useState(false);
  const [solving, setSolving] = useState<{ startedAt: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [notice, setNotice] = useState<{ tone: DropVerdict | "info"; text: string } | null>(null);
  const [hover, setHover] = useState<{ key: string; verdict: DropVerdict } | null>(null);
  const [showBreaches, setShowBreaches] = useState(false);
  const dragRef = useRef<DragPayload | null>(null);
  const pinUndoStack = useRef<string[]>([]);

  // Compile the solver wasm while the user is still reading the grid, so the
  // first Generate does not pay for it.
  useEffect(() => {
    warmSolver();
  }, []);

  const activeShiftId = shiftId ?? shifts.data?.find((s) => s.is_default)?.id ?? shifts.data?.[0]?.id ?? null;
  const dates = useMemo(() => weekDates(weekStart), [weekStart]);

  const staffById = useMemo(
    () => new Map((staff.data ?? []).map((s) => [s.id, s])),
    [staff.data],
  );
  const benchById = useMemo(
    () => new Map((benches.data ?? []).map((b) => [b.id, b])),
    [benches.data],
  );
  const competencyFor = useCallback(
    (staffId: string, benchId: string) =>
      (matrix.data ?? []).find((c) => c.staff_id === staffId && c.bench_id === benchId),
    [matrix.data],
  );

  const rows = assignments.data ?? [];
  const byBenchDay = useMemo(() => pivotByBenchDay(rows), [rows]);
  const byStaffDay = useMemo(() => pivotByStaffDay(rows), [rows]);

  const visibleBenches = useMemo(() => {
    let list = (benches.data ?? []).filter((b) => b.is_active);
    if (groupId) list = list.filter((b) => b.group_id === groupId);
    return list;
  }, [benches.data, groupId]);

  const coverageOf = useCallback(
    (benchId: string, date: string) => {
      if (!activeShiftId) return coverageFor(null, 0);
      const requirement = requirementFor(requirements.data ?? [], benchId, activeShiftId, date);
      const filled = (byBenchDay.get(benchDayKey(benchId, date)) ?? []).length;
      return coverageFor(requirement, filled);
    },
    [activeShiftId, requirements.data, byBenchDay],
  );

  const gridBenches = useMemo(() => {
    if (!gapsOnly) return visibleBenches;
    return visibleBenches.filter((bench) =>
      dates.some((date) => isGap(coverageOf(bench.id, date))),
    );
  }, [gapsOnly, visibleBenches, dates, coverageOf]);

  const summary = useMemo(
    () =>
      summariseWeek(
        visibleBenches.flatMap((bench) => dates.map((date) => coverageOf(bench.id, date))),
      ),
    [visibleBenches, dates, coverageOf],
  );

  const pinCount = pins.data?.length ?? 0;
  const isPublished = published.data?.published_run_id === latestRun?.id && Boolean(latestRun);

  /* -- actions ------------------------------------------------------------ */

  const generate = useCallback(async () => {
    const controller = new AbortController();
    abortRef.current = controller;
    setSolving({ startedAt: Date.now() });
    setNotice(null);
    try {
      const problem = buildProblem({
        weekStart,
        shifts: shifts.data ?? [],
        benches: benches.data ?? [],
        requirements: requirements.data ?? [],
        staff: staff.data ?? [],
        competencies: matrix.data ?? [],
        availability: availability.data ?? [],
        absences: absences.data ?? [],
        rules: rules.data ?? [],
        pins: pins.data ?? [],
        history: priorHistory.data ?? [],
        settings: solverSettings.data ?? [],
      });

      const result = await solveInWorker(problem, controller.signal);

      const { data: auth } = await supabase.auth.getUser();
      await persistRun(problem, result, {
        requestedBy: auth.user?.id ?? null,
        requestedByName:
          (auth.user?.user_metadata?.display_name as string | undefined) ??
          auth.user?.email?.split("@")[0] ??
          null,
      });

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["rota_run"] }),
        queryClient.invalidateQueries({ queryKey: ["assignment"] }),
        queryClient.invalidateQueries({ queryKey: ["rule_breach"] }),
      ]);
    } catch (error) {
      if (error instanceof SolveCancelled) {
        setNotice({ tone: "info", text: "Solve cancelled. Nothing was recorded." });
      } else {
        setNotice({
          tone: "hard",
          text: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      abortRef.current = null;
      setSolving(null);
    }
  }, [
    weekStart, shifts.data, benches.data, requirements.data, staff.data,
    matrix.data, availability.data, absences.data, rules.data, pins.data,
    priorHistory.data, solverSettings.data, queryClient,
  ]);

  const cancelSolve = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const publish = useCallback(async () => {
    if (!latestRun) return;
    setBusy(true);
    const { error } = await supabase.rpc("publish_rota", { p_run_id: latestRun.id });
    setBusy(false);
    if (error) setNotice({ tone: "hard", text: error.message });
    else {
      setNotice({ tone: "info", text: "Published." });
      await queryClient.invalidateQueries({ queryKey: ["rota_week"] });
    }
  }, [latestRun, queryClient]);

  const addPin = useCallback(
    async (staffId: string, benchId: string, date: string) => {
      if (!activeShiftId) return;
      const { data, error } = await supabase
        .from("pin")
        .upsert(
          {
            week_start: weekStart,
            work_date: date,
            shift_id: activeShiftId,
            bench_id: benchId,
            staff_id: staffId,
          },
          { onConflict: "work_date,shift_id,bench_id,staff_id" },
        )
        .select()
        .single();
      if (error) {
        setNotice({ tone: "hard", text: error.message });
        return;
      }
      pinUndoStack.current.push(data.id as string);
      await queryClient.invalidateQueries({ queryKey: ["pin"] });
    },
    [activeShiftId, weekStart, queryClient],
  );

  const removePin = useCallback(
    async (pinId: string) => {
      await supabase.from("pin").delete().eq("id", pinId);
      pinUndoStack.current = pinUndoStack.current.filter((id) => id !== pinId);
      await queryClient.invalidateQueries({ queryKey: ["pin"] });
    },
    [queryClient],
  );

  const clearPins = useCallback(async () => {
    await supabase.from("pin").delete().eq("week_start", weekStart);
    pinUndoStack.current = [];
    await queryClient.invalidateQueries({ queryKey: ["pin"] });
  }, [weekStart, queryClient]);

  /* Cmd+Z / Ctrl+Z undoes the last pin. */
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        const last = pinUndoStack.current.pop();
        if (last) {
          event.preventDefault();
          void removePin(last);
          setNotice({ tone: "info", text: "Pin removed." });
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [removePin]);

  /* -- drag and drop ------------------------------------------------------ */

  function benchOccupants(benchId: string, date: string) {
    return (byBenchDay.get(benchDayKey(benchId, date)) ?? [])
      .map((a) => {
        const person = staffById.get(a.staff_id);
        return person
          ? { staff: person, competency: competencyFor(person.id, benchId) }
          : null;
      })
      .filter(Boolean) as { staff: Staff; competency: ReturnType<typeof competencyFor> }[];
  }

  function verdictFor(staffId: string, bench: Bench, date: string) {
    const person = staffById.get(staffId);
    if (!person || !activeShiftId) {
      return { verdict: "hard" as DropVerdict, reason: "Unknown member of staff." };
    }
    return checkDrop({
      person,
      bench,
      date,
      shiftId: activeShiftId,
      requirement: requirementFor(requirements.data ?? [], bench.id, activeShiftId, date),
      competency: competencyFor(staffId, bench.id),
      availability: availability.data ?? [],
      absences: absences.data ?? [],
      benchStaff: benchOccupants(bench.id, date),
    });
  }

  function onDragStart(payload: DragPayload) {
    return (event: React.DragEvent) => {
      dragRef.current = payload;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", payload.staffId);
    };
  }

  function onDragOver(bench: Bench, date: string) {
    return (event: React.DragEvent) => {
      const payload = dragRef.current;
      if (!payload) return;
      const { verdict } = verdictFor(payload.staffId, bench, date);
      event.dataTransfer.dropEffect = verdict === "hard" ? "none" : "move";
      if (verdict !== "hard") event.preventDefault();
      setHover({ key: benchDayKey(bench.id, date), verdict });
    };
  }

  function onDrop(bench: Bench, date: string) {
    return (event: React.DragEvent) => {
      event.preventDefault();
      const payload = dragRef.current;
      dragRef.current = null;
      setHover(null);
      if (!payload) return;

      const { verdict, reason } = verdictFor(payload.staffId, bench, date);
      if (verdict === "hard") {
        setNotice({ tone: "hard", text: reason });
        return;
      }
      setNotice({ tone: verdict, text: verdict === "soft" ? reason : `Pinned. ${reason}` });
      void addPin(payload.staffId, bench.id, date);
    };
  }

  /* -- export ------------------------------------------------------------- */

  function exportCsv() {
    const header = ["Date", "Day", "Bench", "Staff code", "Name", "Grade", "Source"];
    const lines = [header.join(",")];
    for (const date of dates) {
      for (const bench of visibleBenches) {
        for (const a of byBenchDay.get(benchDayKey(bench.id, date)) ?? []) {
          const person = staffById.get(a.staff_id);
          lines.push(
            [
              date,
              dayShort(date),
              `"${bench.name}"`,
              person?.staff_code ?? "",
              `"${person?.full_name ?? ""}"`,
              person ? GRADE_LABELS[person.grade] : "",
              a.is_pinned ? "pinned" : a.source,
            ].join(","),
          );
        }
      }
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `rota-${weekStart}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  /* -- render ------------------------------------------------------------- */

  const anyError = [benches, staff, requirements, runs].find((q) => q.error)?.error;
  if (anyError) return <ErrorNote error={anyError} />;
  if (benches.isLoading || staff.isLoading || requirements.isLoading) {
    return <Loading what="the week" />;
  }

  return (
    <div className={`board${solving ? " is-solving" : ""}`}>
      <div className="board__bar">
        <div className="segmented" role="group" aria-label="View">
          <button
            type="button"
            className={view === "bench" ? "is-active" : ""}
            onClick={() => setView("bench")}
            aria-pressed={view === "bench"}
          >
            Benches × Days
          </button>
          <button
            type="button"
            className={view === "staff" ? "is-active" : ""}
            onClick={() => setView("staff")}
            aria-pressed={view === "staff"}
          >
            Staff × Days
          </button>
        </div>

        <div className="board__filters">
          <select
            value={shiftId ?? activeShiftId ?? ""}
            onChange={(e) => setFilter({ shiftId: e.target.value || null })}
            aria-label="Shift"
          >
            {(shifts.data ?? []).map((shift) => (
              <option key={shift.id} value={shift.id}>
                {shift.name} {shift.starts_at.slice(0, 5)}–{shift.ends_at.slice(0, 5)}
              </option>
            ))}
          </select>

          <select
            value={groupId ?? ""}
            onChange={(e) => setFilter({ groupId: e.target.value || null })}
            aria-label="Bench group"
          >
            <option value="">All groups</option>
            {(groups.data ?? []).map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </select>

          <label className="checkbox">
            <input
              type="checkbox"
              checked={gapsOnly}
              onChange={(e) => setFilter({ gapsOnly: e.target.checked })}
            />
            Show gaps only
          </label>

          {(shiftId || groupId || gapsOnly) && (
            <button type="button" className="btn btn--quiet" onClick={clearFilters}>
              Clear
            </button>
          )}
        </div>

        <div className="board__actions">
          <span className={`board__gaps${summary.gaps ? " has-gaps" : ""}`}>
            {summary.gaps === 0
              ? "No gaps"
              : `${summary.gaps} ${summary.gaps === 1 ? "gap" : "gaps"}`}
          </span>
          <button type="button" className="btn" onClick={exportCsv} disabled={!rows.length}>
            Export
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={generate}
            disabled={busy || Boolean(solving)}
          >
            {pinCount > 0
              ? `Re-solve around ${pinCount} ${pinCount === 1 ? "pin" : "pins"}`
              : "Generate rota"}
          </button>
          <button
            type="button"
            className="btn"
            onClick={publish}
            disabled={
              busy ||
              !latestRun ||
              !["solved", "solved_with_breaches"].includes(latestRun.status) ||
              isPublished
            }
          >
            {isPublished ? "Published" : "Publish"}
          </button>
        </div>
      </div>

      <SolveStatus
        run={latestRun}
        solving={solving}
        onCancel={cancelSolve}
        onOpenBreaches={() => setShowBreaches(true)}
      />

      {notice && (
        <div className={`notice notice--${notice.tone}`} role="status">
          <span>{notice.text}</span>
          <button type="button" className="btn btn--quiet" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      )}

      {latestRun?.status === "infeasible" && latestRun.infeasible_report && (
        <InfeasiblePanel
          report={latestRun.infeasible_report}
          onClearPins={clearPins}
          onOpenPins={() => setPinsPanelOpen(true)}
        />
      )}

      {showBreaches && (breaches.data ?? []).length > 0 && (
        <div className="breach-strip">
          <div className="breach-strip__head">
            <strong>Soft breaches</strong>
            <button type="button" className="btn btn--quiet" onClick={() => setShowBreaches(false)}>
              Hide
            </button>
          </div>
          <ul>
            {(breaches.data ?? []).map((breach) => (
              <li key={breach.id}>
                <Tag tone="caution">{breach.weight}</Tag>
                <button
                  type="button"
                  className="btn btn--link"
                  onClick={() => {
                    if (breach.bench_id && breach.work_date) {
                      setFilter({ gapsOnly: false });
                      select(
                        breach.staff_id
                          ? {
                              staffId: breach.staff_id,
                              benchId: breach.bench_id,
                              date: breach.work_date,
                            }
                          : null,
                      );
                    }
                  }}
                >
                  {breach.detail}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {rows.length === 0 && !solving && latestRun?.status !== "infeasible" ? (
        <Empty title="Nothing on the rota for this week">
          Generate a rota, or move to a week that already has one.
        </Empty>
      ) : view === "bench" ? (
        <BenchGrid
          benches={gridBenches}
          dates={dates}
          byBenchDay={byBenchDay}
          staffById={staffById}
          coverageOf={coverageOf}
          hover={hover}
          selection={selection}
          onSelect={select}
          onDragStart={onDragStart}
          onDragOver={onDragOver}
          onDragLeave={() => setHover(null)}
          onDrop={onDrop}
          competencyFor={competencyFor}
        />
      ) : (
        <StaffGrid
          staff={staff.data ?? []}
          dates={dates}
          byStaffDay={byStaffDay}
          benchById={benchById}
          selection={selection}
          onSelect={select}
          onDragStart={onDragStart}
        />
      )}

      <PinsPanel
        open={pinsPanelOpen}
        onToggle={() => setPinsPanelOpen(!pinsPanelOpen)}
        pins={pins.data ?? []}
        staffById={staffById}
        benchById={benchById}
        onRemove={removePin}
        onClear={clearPins}
      />
    </div>
  );
}

/* ---------------------------------------------------------------------- */

function BenchGrid({
  benches,
  dates,
  byBenchDay,
  staffById,
  coverageOf,
  hover,
  selection,
  onSelect,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  competencyFor,
}: {
  benches: Bench[];
  dates: string[];
  byBenchDay: Map<string, Assignment[]>;
  staffById: Map<string, Staff>;
  coverageOf: (benchId: string, date: string) => ReturnType<typeof coverageFor>;
  hover: { key: string; verdict: DropVerdict } | null;
  selection: ReturnType<typeof useUiStore.getState>["selection"];
  onSelect: (s: { staffId: string; benchId: string; date: string } | null) => void;
  onDragStart: (payload: DragPayload) => (event: React.DragEvent) => void;
  onDragOver: (bench: Bench, date: string) => (event: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (bench: Bench, date: string) => (event: React.DragEvent) => void;
  competencyFor: (staffId: string, benchId: string) => { level: string } | undefined;
}) {
  if (benches.length === 0) {
    return <Empty title="Nothing matches these filters">Clear a filter to see the week.</Empty>;
  }

  return (
    <div className="grid-wrap">
      <table className="grid grid--bench" onKeyDown={gridArrowKeys}>
        <caption className="visually-hidden">
          Benches down the rows, days across the columns
        </caption>
        <thead>
          <tr>
            <th scope="col" className="grid__corner">
              Bench
            </th>
            {dates.map((date) => (
              <th
                key={date}
                scope="col"
                className={isWeekend(date) ? "grid__day is-weekend" : "grid__day"}
              >
                <span className="grid__day-name">{dayShort(date)}</span>
                <span className="grid__day-date mono">{formatDateShort(date)}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {benches.map((bench) => (
            <tr key={bench.id}>
              <th scope="row" className="grid__rowhead">
                <span className="grid__rowhead-name">{bench.name}</span>
              </th>
              {dates.map((date) => {
                const key = benchDayKey(bench.id, date);
                const coverage = coverageOf(bench.id, date);
                const cellAssignments = byBenchDay.get(key) ?? [];
                const dropState = hover?.key === key ? ` is-drop-${hover.verdict}` : "";
                const gapClass = isGap(coverage) ? " is-gap" : "";
                const idle = coverage.running ? "" : " is-idle";

                return (
                  <td
                    key={date}
                    className={`cell${gapClass}${dropState}${idle}`}
                    tabIndex={0}
                    onDragOver={onDragOver(bench, date)}
                    onDragLeave={onDragLeave}
                    onDrop={onDrop(bench, date)}
                  >
                    <CoverageRail coverage={coverage} />
                    <div className="cell__chips">
                      {cellAssignments.map((assignment) => {
                        const person = staffById.get(assignment.staff_id);
                        if (!person) return null;
                        const competency = competencyFor(person.id, bench.id);
                        const unsupervised =
                          competency?.level === "trainee" &&
                          !cellAssignments.some((other) =>
                            isSignedOff(
                              competencyFor(other.staff_id, bench.id) as never,
                              date,
                            ),
                          );
                        return (
                          <Chip
                            key={assignment.id}
                            person={person}
                            pinned={assignment.is_pinned}
                            unsupervised={unsupervised}
                            selected={
                              selection?.staffId === person.id &&
                              selection?.benchId === bench.id &&
                              selection?.date === date
                            }
                            draggable
                            onDragStart={onDragStart({
                              staffId: person.id,
                              fromBenchId: bench.id,
                              fromDate: date,
                            })}
                            onSelect={() =>
                              onSelect({ staffId: person.id, benchId: bench.id, date })
                            }
                          />
                        );
                      })}
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StaffGrid({
  staff,
  dates,
  byStaffDay,
  benchById,
  selection,
  onSelect,
  onDragStart,
}: {
  staff: Staff[];
  dates: string[];
  byStaffDay: Map<string, Assignment[]>;
  benchById: Map<string, Bench>;
  selection: ReturnType<typeof useUiStore.getState>["selection"];
  onSelect: (s: { staffId: string; benchId: string; date: string } | null) => void;
  onDragStart: (payload: DragPayload) => (event: React.DragEvent) => void;
}) {
  const active = staff.filter((s) => s.status === "active");

  return (
    <div className="grid-wrap">
      <table className="grid grid--staff" onKeyDown={gridArrowKeys}>
        <caption className="visually-hidden">
          Staff down the rows, days across the columns
        </caption>
        <thead>
          <tr>
            <th scope="col" className="grid__corner">
              Staff
            </th>
            {dates.map((date) => (
              <th
                key={date}
                scope="col"
                className={isWeekend(date) ? "grid__day is-weekend" : "grid__day"}
              >
                <span className="grid__day-name">{dayShort(date)}</span>
                <span className="grid__day-date mono">{formatDateShort(date)}</span>
              </th>
            ))}
            <th scope="col" className="grid__day grid__load">
              Days
            </th>
          </tr>
        </thead>
        <tbody>
          {active.map((person) => {
            const worked = dates.filter((d) => (byStaffDay.get(staffDayKey(person.id, d)) ?? []).length);
            return (
              <tr key={person.id}>
                <th scope="row" className="grid__rowhead">
                  <span className="grid__rowhead-name">{person.full_name}</span>
                  <span className="grid__rowhead-sub mono">{person.staff_code}</span>
                </th>
                {dates.map((date) => {
                  const cellAssignments = byStaffDay.get(staffDayKey(person.id, date)) ?? [];
                  return (
                    <td key={date} className="cell cell--staff" tabIndex={0}>
                      <div className="cell__chips">
                        {cellAssignments.map((assignment) => {
                          const bench = benchById.get(assignment.bench_id);
                          if (!bench) return null;
                          return (
                            <Chip
                              key={assignment.id}
                              label={bench.name}
                              title={`${person.full_name} on ${bench.name}`}
                              pinned={assignment.is_pinned}
                              selected={
                                selection?.staffId === person.id &&
                                selection?.benchId === bench.id &&
                                selection?.date === date
                              }
                              draggable
                              onDragStart={onDragStart({
                                staffId: person.id,
                                fromBenchId: bench.id,
                                fromDate: date,
                              })}
                              onSelect={() =>
                                onSelect({ staffId: person.id, benchId: bench.id, date })
                              }
                            />
                          );
                        })}
                        {cellAssignments.length === 0 && (
                          <span className="cell__blank" aria-label="Not on the rota">
                            ·
                          </span>
                        )}
                      </div>
                    </td>
                  );
                })}
                <td className="cell cell--load mono">{worked.length}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** The grid is navigable by arrow keys, as the accessibility floor requires. */
function gridArrowKeys(event: React.KeyboardEvent<HTMLTableElement>) {
  const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];
  if (!keys.includes(event.key)) return;

  const cell = (event.target as HTMLElement).closest("td");
  if (!cell) return;
  const row = cell.parentElement as HTMLTableRowElement;
  const body = row.parentElement as HTMLTableSectionElement;
  const columnIndex = Array.from(row.children).indexOf(cell);
  const rowIndex = Array.from(body.children).indexOf(row);

  let nextRow = rowIndex;
  let nextColumn = columnIndex;
  if (event.key === "ArrowLeft") nextColumn -= 1;
  if (event.key === "ArrowRight") nextColumn += 1;
  if (event.key === "ArrowUp") nextRow -= 1;
  if (event.key === "ArrowDown") nextRow += 1;

  const target = body.children[nextRow]?.children[nextColumn] as HTMLElement | undefined;
  if (target?.tagName === "TD") {
    event.preventDefault();
    target.focus();
  }
}

function PinsPanel({
  open,
  onToggle,
  pins,
  staffById,
  benchById,
  onRemove,
  onClear,
}: {
  open: boolean;
  onToggle: () => void;
  pins: { id: string; staff_id: string; bench_id: string; work_date: string }[];
  staffById: Map<string, Staff>;
  benchById: Map<string, Bench>;
  onRemove: (id: string) => void;
  onClear: () => void;
}) {
  if (pins.length === 0 && !open) return null;

  return (
    <aside className={`pins${open ? " is-open" : ""}`}>
      <button type="button" className="pins__toggle" onClick={onToggle} aria-expanded={open}>
        <span aria-hidden="true">📌</span> {pins.length} pinned{" "}
        <span aria-hidden="true">{open ? "▾" : "▴"}</span>
      </button>
      {open && (
        <div className="pins__body">
          {pins.length === 0 ? (
            <p className="pins__empty">
              Drag someone onto a bench to pin them. Pins are held fixed and everything
              else is re-optimised around them.
            </p>
          ) : (
            <>
              <ul>
                {pins.map((pin) => (
                  <li key={pin.id}>
                    <span className="pins__who">
                      {staffById.get(pin.staff_id)?.full_name ?? "Unknown"}
                    </span>
                    <span className="pins__where">
                      {benchById.get(pin.bench_id)?.name ?? "Unknown bench"},{" "}
                      {dayShort(pin.work_date)}
                    </span>
                    <button
                      type="button"
                      className="btn btn--quiet"
                      onClick={() => onRemove(pin.id)}
                      aria-label={`Remove pin for ${staffById.get(pin.staff_id)?.full_name}`}
                    >
                      Clear
                    </button>
                  </li>
                ))}
              </ul>
              <button type="button" className="btn btn--quiet" onClick={onClear}>
                Clear all pins
              </button>
            </>
          )}
        </div>
      )}
    </aside>
  );
}
