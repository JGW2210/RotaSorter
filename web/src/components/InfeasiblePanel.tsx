import { useNavigate } from "react-router-dom";
import type { InfeasibleReport, InfeasibleSuggestion } from "../lib/types";
import { Tag } from "./Bits";

/* The most important state in the product. It never says "no solution found":
 * it names the conflict, shows who was missing and why, and every suggested
 * resolution is a working link to the thing that needs changing. */
export function InfeasiblePanel({
  report,
  onClearPins,
  onOpenPins,
}: {
  report: InfeasibleReport;
  onClearPins?: () => void;
  onOpenPins?: () => void;
}) {
  const navigate = useNavigate();

  function follow(suggestion: InfeasibleSuggestion) {
    switch (suggestion.action) {
      case "edit_bench":
        navigate(`/benches/${suggestion.bench_id}`);
        break;
      case "matrix":
        navigate(`/competency?bench=${suggestion.bench_id ?? ""}`);
        break;
      case "absences":
        navigate(`/staff?absences=${suggestion.date ?? ""}`);
        break;
      case "edit_rule":
        navigate(`/rules/${suggestion.rule_id}`);
        break;
      case "pause_rule":
        navigate(`/rules?pause=${suggestion.rule_id}`);
        break;
      case "rules":
        navigate("/rules");
        break;
      case "pins":
        onOpenPins?.();
        break;
      case "clear_pins":
        onClearPins?.();
        break;
    }
  }

  return (
    <section className="infeasible" role="alert">
      <h2 className="infeasible__title">{report.summary}</h2>

      {report.conflicts.map((conflict, index) => (
        <div className="infeasible__conflict" key={index}>
          <p className="infeasible__detail">{conflict.detail}</p>
          {conflict.first_failure && (
            <p className="infeasible__sub mono">{conflict.first_failure}</p>
          )}

          {conflict.pool && conflict.pool.length > 0 && (
            <>
              <p className="infeasible__sub">
                Everyone competent on {conflict.bench_name ?? "this bench"}:
              </p>
              <ul className="infeasible__pool">
                {conflict.pool.map((member) => (
                  <li key={member.staff_id}>
                    <span className="mono infeasible__code">{member.staff_code}</span>
                    <span>{member.reason}</span>
                    <Tag tone={member.level === "trainee" ? "caution" : "neutral"}>
                      {member.level}
                    </Tag>
                  </li>
                ))}
              </ul>
            </>
          )}

          {conflict.pins && conflict.pins.length > 0 && (
            <ul className="infeasible__pool">
              {conflict.pins.map((pin, i) => (
                <li key={i}>
                  <span>
                    📌 {pin.name} on {pin.bench_name}, {pin.day_name}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}

      {report.note && <p className="infeasible__sub">{report.note}</p>}

      {report.suggestions.length > 0 && (
        <div className="infeasible__try">
          <span className="infeasible__try-label">Try:</span>
          {report.suggestions.map((suggestion, index) => (
            <button
              key={index}
              type="button"
              className="btn btn--link"
              onClick={() => follow(suggestion)}
            >
              {suggestion.label}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
