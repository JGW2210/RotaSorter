import { addWeeks, currentWeekStart, formatWeekLabel, mondayOf } from "../lib/week";

export function WeekSelector({
  value,
  onChange,
}: {
  value: string;
  onChange: (week: string) => void;
}) {
  const isThisWeek = value === currentWeekStart();

  return (
    <div className="week-selector">
      <button
        type="button"
        className="week-selector__step"
        onClick={() => onChange(addWeeks(value, -1))}
        aria-label="Previous week"
      >
        ‹
      </button>

      <label className="week-selector__label">
        <span className="visually-hidden">Week beginning</span>
        <input
          type="date"
          value={value}
          onChange={(event) => {
            if (event.target.value) onChange(mondayOf(event.target.value));
          }}
        />
        <span aria-hidden="true">{formatWeekLabel(value)}</span>
      </label>

      <button
        type="button"
        className="week-selector__step"
        onClick={() => onChange(addWeeks(value, 1))}
        aria-label="Next week"
      >
        ›
      </button>

      {!isThisWeek && (
        <button
          type="button"
          className="week-selector__today"
          onClick={() => onChange(currentWeekStart())}
        >
          This week
        </button>
      )}
    </div>
  );
}
