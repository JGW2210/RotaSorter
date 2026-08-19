/** React Query hooks over the Supabase tables. */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "./supabase";
import { addWeeks } from "./week";
import type {
  Absence,
  Assignment,
  Availability,
  Bench,
  BenchGroup,
  BenchPool,
  BenchShiftRequirement,
  Competency,
  CompetencyDocument,
  MatrixCell,
  Pin,
  RotaRun,
  RotaWeek,
  Rule,
  RuleBreach,
  Shift,
  SolverSetting,
  Staff,
  StaffCompetencySummary,
  StaffDocument,
} from "./types";

async function selectAll<T>(table: string, columns = "*", order?: string): Promise<T[]> {
  let query = supabase.from(table).select(columns);
  if (order) query = query.order(order);
  const { data, error } = await query;
  if (error) throw new Error(`${table}: ${error.message}`);
  return (data ?? []) as T[];
}

/* Deliberately untyped: annotating this as Partial<UseQueryOptions> erases the
 * return type of every hook that spreads it, and each one silently becomes {}. */
const REFERENCE = { staleTime: 5 * 60 * 1000 };

export const useShifts = () =>
  useQuery({
    queryKey: ["shift"],
    queryFn: () => selectAll<Shift>("shift", "*", "sort_order"),
    ...REFERENCE,
  });

export const useBenchGroups = () =>
  useQuery({
    queryKey: ["bench_group"],
    queryFn: () => selectAll<BenchGroup>("bench_group", "*", "sort_order"),
    ...REFERENCE,
  });

export const useBenches = () =>
  useQuery({
    queryKey: ["bench"],
    queryFn: () =>
      selectAll<Bench>("bench", "*, bench_group(name)", "sort_order"),
    ...REFERENCE,
  });

export const useBenchRequirements = () =>
  useQuery({
    queryKey: ["bench_shift_requirement"],
    queryFn: () => selectAll<BenchShiftRequirement>("bench_shift_requirement"),
    ...REFERENCE,
  });

export const useBenchPools = () =>
  useQuery({
    queryKey: ["v_bench_pool"],
    queryFn: () => selectAll<BenchPool>("v_bench_pool", "*", "sort_order"),
  });

export const useStaff = () =>
  useQuery({
    queryKey: ["staff"],
    queryFn: () => selectAll<Staff>("staff", "*", "full_name"),
    ...REFERENCE,
  });

export const useStaffSummaries = () =>
  useQuery({
    queryKey: ["v_staff_competency_summary"],
    queryFn: () => selectAll<StaffCompetencySummary>("v_staff_competency_summary"),
  });

export const useAvailability = () =>
  useQuery({
    queryKey: ["availability"],
    queryFn: () => selectAll<Availability>("availability"),
    ...REFERENCE,
  });

export const useAbsences = () =>
  useQuery({
    queryKey: ["absence"],
    queryFn: () => selectAll<Absence>("absence", "*", "starts_on"),
  });

export const useCompetencyMatrix = () =>
  useQuery({
    queryKey: ["v_competency_matrix"],
    queryFn: () => selectAll<MatrixCell>("v_competency_matrix"),
  });

export const useCompetencyDocuments = () =>
  useQuery({
    queryKey: ["competency_document"],
    queryFn: () =>
      selectAll<CompetencyDocument>("competency_document", "*", "sort_order"),
    ...REFERENCE,
  });

export const useStaffDocuments = (staffId: string | undefined) =>
  useQuery({
    queryKey: ["staff_document", staffId],
    enabled: Boolean(staffId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("staff_document")
        .select("*")
        .eq("staff_id", staffId!);
      if (error) throw new Error(error.message);
      return (data ?? []) as StaffDocument[];
    },
  });

export const useRules = () =>
  useQuery({
    queryKey: ["rule"],
    queryFn: () => selectAll<Rule>("rule", "*", "name"),
  });

export const useSolverSettings = () =>
  useQuery({
    queryKey: ["solver_setting"],
    queryFn: () => selectAll<SolverSetting>("solver_setting", "*", "sort_order"),
  });

/* -- week-scoped ---------------------------------------------------------- */

export const useWeekRuns = (weekStart: string) =>
  useQuery({
    queryKey: ["rota_run", weekStart],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("rota_run")
        .select("*")
        .eq("week_start", weekStart)
        .order("requested_at", { ascending: false });
      if (error) throw new Error(error.message);
      return (data ?? []) as RotaRun[];
    },
  });

export const useAllRuns = (limit = 100) =>
  useQuery({
    queryKey: ["rota_run", "all", limit],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("rota_run")
        .select("*")
        .order("requested_at", { ascending: false })
        .limit(limit);
      if (error) throw new Error(error.message);
      return (data ?? []) as RotaRun[];
    },
  });

export const useAssignments = (runId: string | undefined) =>
  useQuery({
    queryKey: ["assignment", runId],
    enabled: Boolean(runId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("assignment")
        .select("*")
        .eq("run_id", runId!);
      if (error) throw new Error(error.message);
      return (data ?? []) as Assignment[];
    },
  });

export const useRecentAssignments = (staffId: string | undefined, weeks = 4) =>
  useQuery({
    queryKey: ["assignment", "recent", staffId, weeks],
    enabled: Boolean(staffId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("assignment")
        .select("*")
        .eq("staff_id", staffId!)
        .order("work_date", { ascending: false })
        .limit(weeks * 7);
      if (error) throw new Error(error.message);
      return (data ?? []) as Assignment[];
    },
  });

export const useBreaches = (runId: string | undefined) =>
  useQuery({
    queryKey: ["rule_breach", runId],
    enabled: Boolean(runId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("rule_breach")
        .select("*")
        .eq("run_id", runId!);
      if (error) throw new Error(error.message);
      return (data ?? []) as RuleBreach[];
    },
  });

export const usePins = (weekStart: string) =>
  useQuery({
    queryKey: ["pin", weekStart],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("pin")
        .select("*")
        .eq("week_start", weekStart);
      if (error) throw new Error(error.message);
      return (data ?? []) as Pin[];
    },
  });

/** Last week's published assignments, so rules that count runs of days can
 *  see across the Sunday-to-Monday boundary. Empty when nothing is published. */
export const usePriorWeekHistory = (weekStart: string) =>
  useQuery({
    queryKey: ["prior_week_history", weekStart],
    queryFn: async () => {
      const prior = addWeeks(weekStart, -1);
      const { data: week, error } = await supabase
        .from("rota_week")
        .select("published_run_id")
        .eq("week_start", prior)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!week?.published_run_id) return [] as Assignment[];
      const { data, error: assignmentError } = await supabase
        .from("assignment")
        .select("*")
        .eq("run_id", week.published_run_id);
      if (assignmentError) throw new Error(assignmentError.message);
      return (data ?? []) as Assignment[];
    },
  });

export const usePublishedWeek = (weekStart: string) =>
  useQuery({
    queryKey: ["rota_week", weekStart],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("rota_week")
        .select("*")
        .eq("week_start", weekStart)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data ?? null) as RotaWeek | null;
    },
  });

/* -- mutations ------------------------------------------------------------ */

export function useUpsert<T extends { id?: string }>(table: string, invalidate: string[]) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (row: Partial<T>) => {
      const { data, error } = await supabase
        .from(table)
        .upsert(row as never)
        .select()
        .single();
      if (error) throw new Error(error.message);
      return data as T;
    },
    onSuccess: () => {
      for (const key of invalidate) client.invalidateQueries({ queryKey: [key] });
    },
  });
}

export function useDelete(table: string, invalidate: string[]) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from(table).delete().eq("id", id);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      for (const key of invalidate) client.invalidateQueries({ queryKey: [key] });
    },
  });
}

export function useSetCompetency() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (row: Partial<Competency> & { staff_id: string; bench_id: string }) => {
      const { error } = await supabase
        .from("competency")
        .upsert(row as never, { onConflict: "staff_id,bench_id" });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["v_competency_matrix"] });
      client.invalidateQueries({ queryKey: ["v_bench_pool"] });
      client.invalidateQueries({ queryKey: ["v_staff_competency_summary"] });
    },
  });
}

export function useClearCompetency() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ staffId, benchId }: { staffId: string; benchId: string }) => {
      const { error } = await supabase
        .from("competency")
        .delete()
        .eq("staff_id", staffId)
        .eq("bench_id", benchId);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["v_competency_matrix"] });
      client.invalidateQueries({ queryKey: ["v_bench_pool"] });
      client.invalidateQueries({ queryKey: ["v_staff_competency_summary"] });
    },
  });
}
