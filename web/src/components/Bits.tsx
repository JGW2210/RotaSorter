import type { ReactNode } from "react";

export function Panel({
  title,
  actions,
  children,
  className = "",
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`.trim()}>
      {(title || actions) && (
        <div className="panel__head">
          {typeof title === "string" ? <h2>{title}</h2> : title}
          {actions && <div className="panel__actions">{actions}</div>}
        </div>
      )}
      <div className="panel__body">{children}</div>
    </section>
  );
}

export function Toolbar({ children }: { children: ReactNode }) {
  return <div className="toolbar">{children}</div>;
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      {children}
      {hint && <span className="field__hint">{hint}</span>}
    </label>
  );
}

export function Tag({
  tone = "neutral",
  glyph,
  children,
}: {
  tone?: "neutral" | "ok" | "caution" | "alert" | "override" | "accent";
  glyph?: string;
  children: ReactNode;
}) {
  return (
    <span className={`tag tag--${tone}`}>
      {glyph && (
        <span className="tag__glyph" aria-hidden="true">
          {glyph}
        </span>
      )}
      {children}
    </span>
  );
}

export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function Loading({ what = "data" }: { what?: string }) {
  return (
    <div className="loading">
      <span className="loading__pulse" aria-hidden="true" />
      Loading {what}…
    </div>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className="error-note" role="alert">
      <strong>Could not load this.</strong>
      <p className="mono">{message}</p>
      <p>
        If this says a relation does not exist, the migrations in{" "}
        <code>supabase/migrations</code> have not been run yet. See{" "}
        <code>docs/SETUP.md</code>.
      </p>
    </div>
  );
}
