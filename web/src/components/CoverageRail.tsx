import type { Coverage } from "../lib/coverage";
import { isGap } from "../lib/coverage";

/* The signature element. A thin stacked bar at the top of every cell showing
 * filled against required, so a gap is pre-attentive: you see it before you
 * read anything. This is the only place the alert colour is allowed. */
export function CoverageRail({ coverage }: { coverage: Coverage }) {
  if (!coverage.running) {
    return (
      <div className="coverage coverage--idle">
        <span className="coverage__label">Not run</span>
      </div>
    );
  }

  const segments = Math.max(coverage.min, coverage.filled, 1);
  const state = isGap(coverage) ? "gap" : coverage.state;

  return (
    <div className={`coverage coverage--${state}`}>
      <div
        className="coverage__bar"
        role="img"
        aria-label={`${coverage.filled} of ${coverage.min} required`}
      >
        {Array.from({ length: segments }, (_, i) => (
          <span
            key={i}
            className={
              i < coverage.filled
                ? "coverage__seg coverage__seg--filled"
                : "coverage__seg"
            }
          />
        ))}
      </div>
      <span className="coverage__label mono">
        {isGap(coverage) && (
          <span className="coverage__flag" aria-hidden="true">
            ▲
          </span>
        )}
        {coverage.label}
      </span>
    </div>
  );
}
