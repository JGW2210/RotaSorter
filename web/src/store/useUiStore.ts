import { create } from "zustand";
import { persist } from "zustand/middleware";
import { currentWeekStart } from "../lib/week";

export type BoardView = "bench" | "staff";
export type Density = "compact" | "comfortable";

export interface Selection {
  staffId: string;
  benchId: string;
  date: string;
}

interface UiState {
  /** Week-scoped is almost every screen, so the selector lives above them all
   *  and survives moving between sections. */
  weekStart: string;
  setWeekStart: (week: string) => void;

  view: BoardView;
  setView: (view: BoardView) => void;

  /** Filters persist above the grid and survive the view toggle. */
  shiftId: string | null;
  groupId: string | null;
  gapsOnly: boolean;
  levelFilter: string | null;
  setFilter: (patch: Partial<Pick<UiState, "shiftId" | "groupId" | "gapsOnly" | "levelFilter">>) => void;
  clearFilters: () => void;

  /** A selected assignment stays selected across a view toggle. */
  selection: Selection | null;
  select: (selection: Selection | null) => void;

  pinsPanelOpen: boolean;
  setPinsPanelOpen: (open: boolean) => void;

  density: Density;
  setDensity: (density: Density) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      weekStart: currentWeekStart(),
      setWeekStart: (weekStart) => set({ weekStart, selection: null }),

      view: "bench",
      setView: (view) => set({ view }),

      shiftId: null,
      groupId: null,
      gapsOnly: false,
      levelFilter: null,
      setFilter: (patch) => set(patch),
      clearFilters: () =>
        set({ shiftId: null, groupId: null, gapsOnly: false, levelFilter: null }),

      selection: null,
      select: (selection) => set({ selection }),

      pinsPanelOpen: false,
      setPinsPanelOpen: (pinsPanelOpen) => set({ pinsPanelOpen }),

      density: "compact",
      setDensity: (density) => set({ density }),
    }),
    {
      name: "rotasorter-ui",
      // Filters and selection are per-sitting; the week and density are not.
      partialize: (state) => ({ weekStart: state.weekStart, density: state.density, view: state.view }),
    },
  ),
);
