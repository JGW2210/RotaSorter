import { useState, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";
import { useUiStore } from "../store/useUiStore";
import { WeekSelector } from "./WeekSelector";

/* A persistent left rail rather than a top bar: the primary content is a wide
 * grid, and vertical chrome costs less horizontal room than a header costs
 * vertical. */
const SECTIONS = [
  { to: "/rota", label: "Rota" },
  { to: "/staff", label: "Staff" },
  { to: "/benches", label: "Benches" },
  { to: "/competency", label: "Competency" },
  { to: "/rules", label: "Rules" },
  { to: "/runs", label: "Runs" },
];

export function Shell({ session, children }: { session: Session; children: ReactNode }) {
  const { pathname } = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const name =
    (session.user.user_metadata?.display_name as string | undefined) ??
    session.user.email?.split("@")[0] ??
    "Signed in";

  return (
    <div className="shell">
      <nav className="rail" aria-label="Sections">
        <div className="rail__brand">
          <span className="rail__mark" aria-hidden="true" />
          RotaSorter
        </div>

        <ul className="rail__list">
          {SECTIONS.map((section) => (
            <li key={section.to}>
              <NavLink
                to={section.to}
                className={({ isActive }) =>
                  `rail__link${isActive || pathname.startsWith(section.to) ? " is-active" : ""}`
                }
              >
                {section.label}
              </NavLink>
            </li>
          ))}
        </ul>

        <div className="rail__foot">
          <NavLink
            to="/settings"
            className={({ isActive }) => `rail__link${isActive ? " is-active" : ""}`}
          >
            Settings
          </NavLink>
          <div className="rail__user">
            <button
              type="button"
              className="rail__link rail__link--button"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
            >
              {name} <span aria-hidden="true">▾</span>
            </button>
            {menuOpen && (
              <div className="rail__menu" role="menu">
                <span className="rail__menu-email">{session.user.email}</span>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => void supabase.auth.signOut()}
                >
                  Sign out
                </button>
              </div>
            )}
          </div>
        </div>
      </nav>

      <div className="main">
        <Header />
        <div className="content">{children}</div>
      </div>
    </div>
  );
}

/* The week selector lives in the header because almost every screen is
 * week-scoped, and it keeps its value when you move between sections. */
function Header() {
  const { pathname } = useLocation();
  const weekStart = useUiStore((s) => s.weekStart);
  const setWeekStart = useUiStore((s) => s.setWeekStart);
  const title =
    SECTIONS.find((s) => pathname.startsWith(s.to))?.label ??
    (pathname.startsWith("/settings") ? "Settings" : "RotaSorter");

  return (
    <header className="header">
      <h1 className="header__title">{title}</h1>
      <WeekSelector value={weekStart} onChange={setWeekStart} />
      <div className="header__actions" id="header-actions" />
    </header>
  );
}
