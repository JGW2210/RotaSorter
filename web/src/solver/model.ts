/** A small mixed-integer model, serialised to CPLEX LP format for HiGHS.
 *
 * Variables are referred to by index and named `v0`, `v1`, … in the LP text.
 * Short names matter: the seeded week is around 700 variables and the LP string
 * is parsed on every solve.
 */

export type Op = "<=" | ">=" | "==";

export interface Term {
  /** Variable index. */
  v: number;
  /** Coefficient. */
  c: number;
}

export interface Row {
  name: string;
  terms: Term[];
  op: Op;
  rhs: number;
}

interface Column {
  kind: "binary" | "continuous";
  lo: number;
  hi: number | null;
  /** Fixed to this value, which is cheaper than a row. */
  fixed: number | null;
}

export class MipModel {
  private columns: Column[] = [];
  private rows: Row[] = [];
  private objective = new Map<number, number>();
  /** Constant part of the objective, kept so the value matches the reference. */
  objectiveConstant = 0;

  /**
   * Set when two constraints fix the same variable to different values — a pin
   * on a slot a hard rule forbids, say. CP-SAT would simply report the model
   * infeasible; `fix` would silently overwrite, so the contradiction is
   * recorded here and solve() reports it without troubling HiGHS.
   */
  trivallyInfeasible: string | null = null;

  get variableCount(): number {
    return this.columns.length;
  }

  get rowCount(): number {
    return this.rows.length;
  }

  get binaryCount(): number {
    return this.columns.filter((c) => c.kind === "binary" && c.fixed === null).length;
  }

  addBinary(): number {
    this.columns.push({ kind: "binary", lo: 0, hi: 1, fixed: null });
    return this.columns.length - 1;
  }

  addContinuous(lo = 0, hi: number | null = null): number {
    this.columns.push({ kind: "continuous", lo, hi, fixed: null });
    return this.columns.length - 1;
  }

  /** Pin a variable to a value. Cheaper than adding an equality row. */
  fix(v: number, value: number, what = `variable ${v}`): void {
    const existing = this.columns[v].fixed;
    if (existing !== null && existing !== value) {
      this.trivallyInfeasible ??=
        `${what} is required to be both ${existing} and ${value}.`;
      return;
    }
    this.columns[v].fixed = value;
  }

  isFixed(v: number): number | null {
    return this.columns[v].fixed;
  }

  add(terms: Term[], op: Op, rhs: number): void {
    const merged = MipModel.merge(terms);
    if (merged.length === 0) {
      // Every term cancelled. The row is now a statement about constants, and
      // if it is false the model really is infeasible.
      const holds = op === "<=" ? 0 <= rhs : op === ">=" ? 0 >= rhs : rhs === 0;
      if (!holds) this.trivallyInfeasible ??= `A constraint reduced to 0 ${op} ${rhs}.`;
      return;
    }
    this.rows.push({ name: `r${this.rows.length}`, terms: merged, op, rhs });
  }

  /** Σ terms, with every variable at coefficient 1. */
  static sum(vars: number[]): Term[] {
    return vars.map((v) => ({ v, c: 1 }));
  }

  /**
   * Combine repeated variables into one term.
   *
   * Needed wherever a variable appears on both sides of an encoding — a
   * supervisor slot counts once towards "anyone on this bench" and again,
   * negatively, towards "a supervisor is on it" — because LP format has no
   * defined meaning for the same column twice in one row.
   */
  static merge(terms: Term[]): Term[] {
    const totals = new Map<number, number>();
    for (const t of terms) totals.set(t.v, (totals.get(t.v) ?? 0) + t.c);
    return [...totals.entries()]
      .filter(([, c]) => c !== 0)
      .map(([v, c]) => ({ v, c }));
  }

  cost(v: number, coefficient: number): void {
    if (coefficient === 0) return;
    this.objective.set(v, (this.objective.get(v) ?? 0) + coefficient);
  }

  private static coefficient(c: number, first: boolean): string {
    const sign = c < 0 ? "-" : first ? "" : "+";
    const magnitude = Math.abs(c);
    const value = Number.isInteger(magnitude) ? String(magnitude) : magnitude.toFixed(6);
    return first && c >= 0 ? `${value} ` : `${sign} ${value} `;
  }

  private static expression(terms: Term[]): string {
    return terms
      .map((t, i) => `${MipModel.coefficient(t.c, i === 0)}v${t.v}`)
      .join(" ");
  }

  /**
   * What the fixed variables contribute to the objective.
   *
   * toLp() leaves fixed columns out of the objective row, which is right — the
   * solver cannot move them — but their cost is still part of the objective
   * value. Forgetting this makes every pinned slot lose its utilisation credit,
   * so a pinned week looks worse than the identical unpinned one.
   */
  get fixedObjective(): number {
    let total = 0;
    for (const [v, coefficient] of this.objective) {
      const fixed = this.columns[v].fixed;
      if (fixed !== null) total += coefficient * fixed;
    }
    return total;
  }

  toLp(): string {
    const parts: string[] = ["Minimize"];

    const objTerms = [...this.objective.entries()]
      .filter(([v]) => this.columns[v].fixed === null)
      .map(([v, c]) => ({ v, c }));
    parts.push(objTerms.length ? ` obj: ${MipModel.expression(objTerms)}` : " obj: 0 v0");

    parts.push("Subject To");
    for (const row of this.rows) {
      // Fixed variables are folded into the right hand side rather than
      // written out, so HiGHS never sees a column it cannot move.
      let rhs = row.rhs;
      const live: Term[] = [];
      for (const term of row.terms) {
        const fixed = this.columns[term.v].fixed;
        if (fixed === null) live.push(term);
        else rhs -= term.c * fixed;
      }
      if (live.length === 0) continue;
      const op = row.op === "==" ? "=" : row.op;
      parts.push(` ${row.name}: ${MipModel.expression(live)} ${op} ${rhs}`);
    }

    const bounds: string[] = [];
    const binaries: string[] = [];
    for (let v = 0; v < this.columns.length; v++) {
      const column = this.columns[v];
      if (column.fixed !== null) continue;
      if (column.kind === "binary") {
        binaries.push(`v${v}`);
        continue;
      }
      if (column.hi === null) bounds.push(` v${v} >= ${column.lo}`);
      else bounds.push(` ${column.lo} <= v${v} <= ${column.hi}`);
    }

    if (bounds.length) {
      parts.push("Bounds");
      parts.push(...bounds);
    }
    if (binaries.length) {
      parts.push("Binary");
      // Wrapped: a single multi-megabyte line is slower to parse and
      // impossible to read when a model needs debugging.
      for (let i = 0; i < binaries.length; i += 20) {
        parts.push(` ${binaries.slice(i, i + 20).join(" ")}`);
      }
    }

    parts.push("End");
    return parts.join("\n");
  }

  /** Read a solution back, mapping fixed variables to their pinned value. */
  values(columns: Record<string, { Primal: number }>): number[] {
    const out = new Array<number>(this.columns.length).fill(0);
    for (let v = 0; v < this.columns.length; v++) {
      const fixed = this.columns[v].fixed;
      if (fixed !== null) {
        out[v] = fixed;
        continue;
      }
      const primal = columns[`v${v}`]?.Primal;
      out[v] = primal === undefined ? 0 : Math.round(primal * 1e6) / 1e6;
    }
    return out;
  }
}
