import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Empty, ErrorNote, Loading, Tag, Toolbar } from "../components/Bits";
import { LEVEL_LABELS } from "../lib/format";
import {
  useBenchGroups,
  useBenchPools,
  useBenchRequirements,
  useBenches,
  useCompetencyDocuments,
} from "../lib/queries";
import { WEEKDAY_SHORT } from "../lib/week";

function DayStrip({ weekdays }: { weekdays: number[] }) {
  const set = new Set(weekdays);
  return (
    <span className="pattern" aria-label={`Runs ${weekdays.map((d) => WEEKDAY_SHORT[d - 1]).join(", ")}`}>
      {WEEKDAY_SHORT.map((label, index) => (
        <span
          key={label}
          className={set.has(index + 1) ? "pattern__on" : "pattern__off"}
          aria-hidden="true"
        >
          {set.has(index + 1) ? label[0] : "·"}
        </span>
      ))}
    </span>
  );
}

export default function Benches() {
  const benches = useBenches();
  const groups = useBenchGroups();
  const pools = useBenchPools();
  const requirements = useBenchRequirements();
  const documents = useCompetencyDocuments();
  const [groupId, setGroupId] = useState("");

  const poolById = useMemo(
    () => new Map((pools.data ?? []).map((p) => [p.bench_id, p])),
    [pools.data],
  );
  const docsByBench = useMemo(() => {
    const out = new Map<string, string[]>();
    for (const doc of documents.data ?? []) {
      out.set(doc.bench_id, [...(out.get(doc.bench_id) ?? []), doc.doc_number]);
    }
    return out;
  }, [documents.data]);
  const reqsByBench = useMemo(() => {
    const out = new Map<string, number[]>();
    for (const req of requirements.data ?? []) {
      out.set(req.bench_id, [...(out.get(req.bench_id) ?? []), ...(req.weekdays ?? [])]);
    }
    return out;
  }, [requirements.data]);

  const rows = useMemo(() => {
    let list = benches.data ?? [];
    if (groupId) list = list.filter((b) => b.group_id === groupId);
    return list;
  }, [benches.data, groupId]);

  if (benches.error) return <ErrorNote error={benches.error} />;
  if (benches.isLoading) return <Loading what="benches" />;
  if ((benches.data ?? []).length === 0) {
    return <Empty title="No benches yet">Run the seed files in supabase/seed.</Empty>;
  }

  return (
    <>
      <Toolbar>
        <select value={groupId} onChange={(e) => setGroupId(e.target.value)} aria-label="Group">
          <option value="">All groups</option>
          {(groups.data ?? []).map((group) => (
            <option key={group.id} value={group.id}>
              {group.name}
            </option>
          ))}
        </select>
        <span className="toolbar__count">{rows.length} benches</span>
      </Toolbar>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Bench</th>
              <th>Group</th>
              <th>Runs</th>
              <th>Min</th>
              <th>Max</th>
              <th>Required level</th>
              <th>Documents</th>
              <th>Competent staff</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((bench) => {
              const pool = poolById.get(bench.id);
              const competent = pool?.competent_count ?? 0;
              /* A bench whose competent pool equals its minimum has no
                 resilience: it goes infeasible the first time someone takes
                 leave. That is worth flagging before it happens. */
              const thin = competent <= bench.min_staff;
              return (
                <tr key={bench.id}>
                  <td>
                    <Link to={`/benches/${bench.id}`}>{bench.name}</Link>
                  </td>
                  <td>{bench.bench_group?.name ?? "—"}</td>
                  <td>
                    <DayStrip weekdays={[...new Set(reqsByBench.get(bench.id) ?? [])].sort()} />
                  </td>
                  <td className="mono">{bench.min_staff}</td>
                  <td className="mono">{bench.max_staff ?? "—"}</td>
                  <td>{LEVEL_LABELS[bench.required_level]}</td>
                  <td className="mono docs">
                    {(docsByBench.get(bench.id) ?? []).join(" ")}
                  </td>
                  <td>
                    {thin ? (
                      <Tag tone="caution" glyph="◐">
                        {competent} for a minimum of {bench.min_staff}
                      </Tag>
                    ) : (
                      <>
                        {competent}
                        {pool?.trainee_count ? (
                          <span className="muted"> · {pool.trainee_count} training</span>
                        ) : null}
                      </>
                    )}
                    {pool?.expired_count ? (
                      <Tag tone="alert" glyph="✕">
                        {pool.expired_count} expired
                      </Tag>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
