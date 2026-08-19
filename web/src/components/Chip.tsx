import type { DragEvent } from "react";
import { GRADE_LABELS, initials } from "../lib/format";
import type { Staff } from "../lib/types";

/* One chip component shared by both grids, so pinning, selection and conflict
 * styling stay identical whichever way the week is pivoted. */
export function Chip({
  person,
  label,
  pinned = false,
  selected = false,
  breached = false,
  unsupervised = false,
  draggable = false,
  onSelect,
  onDragStart,
  title,
}: {
  person?: Staff;
  label?: string;
  pinned?: boolean;
  selected?: boolean;
  breached?: boolean;
  unsupervised?: boolean;
  draggable?: boolean;
  onSelect?: () => void;
  onDragStart?: (event: DragEvent<HTMLElement>) => void;
  title?: string;
}) {
  const text = label ?? (person ? initials(person.full_name) : "?");
  const description =
    title ??
    (person ? `${person.full_name} · ${GRADE_LABELS[person.grade]}` : undefined);

  const classes = [
    "chip",
    pinned && "chip--pinned",
    selected && "is-selected",
    breached && "chip--breached",
    unsupervised && "chip--unsupervised",
    person && `chip--${person.grade}`,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      type="button"
      className={classes}
      draggable={draggable}
      onDragStart={onDragStart}
      onClick={onSelect}
      title={description}
      aria-pressed={selected}
    >
      {/* Provenance carries a glyph as well as a hue: a pin is legible when
          printed, and to anyone who cannot separate the two colours. */}
      {pinned && (
        <span className="chip__glyph" aria-hidden="true">
          📌
        </span>
      )}
      <span className="chip__text">{text}</span>
      {pinned && <span className="visually-hidden">pinned</span>}
      {description && <span className="visually-hidden">{description}</span>}
    </button>
  );
}
