import { useEffect, useMemo, useState } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import { Badge, Button } from "@/components/ui";
import type { TaskComponentProps } from "@/components/renderer/types";
import type { SortableItem, SortableListProps } from "@/lib/protocol";
import { cn } from "@/lib/utils";

/**
 * Ordering by hand.
 *
 * Agents are bad at knowing what a human means by "correct order" and good at explaining why
 * each step exists, so the human drags and the agent reads the resulting `order` array. Each
 * move is reported as it happens (`change`, non-terminal) so the plan can be watched being
 * built; the explicit submit is what closes the card.
 *
 * The on-screen hint spells out the Space step on purpose: dnd-kit picks an item up on
 * Space/Enter and only then reads the arrows, so "use the arrow keys" alone leaves a
 * keyboard user pressing a key that does nothing.
 */

export default function SortableList({
  props,
  respond,
  resolved,
}: TaskComponentProps<SortableListProps>) {
  const { items, requireAll = false, submitLabel = "Submit order" } = props;

  const [order, setOrder] = useState<string[]>(() => items.map((item) => item.id));
  const [announcement, setAnnouncement] = useState("");

  const byId = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);

  // An agent may update the items mid-flight (a step added, one withdrawn). Keep the order
  // the human already chose for the survivors and append anything new.
  useEffect(() => {
    setOrder((previous) => {
      const survivors = previous.filter((id) => byId.has(id));
      const added = items.map((item) => item.id).filter((id) => !survivors.includes(id));
      return added.length === 0 && survivors.length === previous.length
        ? previous
        : [...survivors, ...added];
    });
  }, [byId, items]);

  const sensors = useSensors(
    // A few pixels of slop so a plain click on the handle is not read as a drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const ordered = useMemo(
    () => order.map((id) => byId.get(id)).filter((item): item is SortableItem => Boolean(item)),
    [byId, order],
  );

  const labels = useMemo(
    () => Object.fromEntries(ordered.map((item) => [item.id, item.label])),
    [ordered],
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = order.indexOf(String(active.id));
    const to = order.indexOf(String(over.id));
    if (from < 0 || to < 0) return;

    const next = arrayMove(order, from, to);
    setOrder(next);
    respond("change", { order: next });
    const moved = byId.get(String(active.id));
    setAnnouncement(
      `${moved?.label ?? "Item"} moved to position ${to + 1} of ${next.length}.`,
    );
  };

  // Only reachable if an agent swaps the items out mid-flight: the order would no longer
  // describe a permutation of what is on screen.
  const problems: string[] = [];
  if (requireAll) {
    if (ordered.length !== items.length) {
      problems.push("Every item has to be placed before this can be submitted.");
    }
    if (new Set(order).size !== order.length) {
      problems.push("An item appears more than once.");
    }
  }
  const canSubmit = problems.length === 0;

  return (
    <div className="flex flex-col gap-3">
      {resolved ? (
        <ol className="flex flex-col gap-2.5">
          {ordered.map((item, index) => (
            <li
              key={item.id}
              className="flex items-center gap-3.5 rounded-lg border border-border bg-card/40 px-4 py-2.5"
            >
              <span className="w-5 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
                {index + 1}
              </span>
              <span className="text-sm">{item.label}</span>
            </li>
          ))}
        </ol>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={order} strategy={verticalListSortingStrategy}>
            <ol className="flex flex-col gap-2.5">
              {ordered.map((item, index) => (
                <SortableRow key={item.id} item={item} position={index + 1} />
              ))}
            </ol>
          </SortableContext>
        </DndContext>
      )}

      {/* Screen-reader users get the same "where did it move" feedback as sighted ones. */}
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>

      {resolved ? null : (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-[11px] text-muted-foreground">
            {problems.length > 0
              ? problems.join(" ")
              : "Drag a handle, or focus one and press Space, then use the arrow keys."}
          </p>
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              if (!canSubmit) return;
              respond("submit", { component: "SortableList", order, labels });
            }}
            disabled={!canSubmit}
          >
            {submitLabel}
          </Button>
        </div>
      )}
    </div>
  );
}

function SortableRow({ item, position }: { item: SortableItem; position: number }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id });

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "flex items-start gap-3 rounded-lg border border-border bg-card/60 p-3.5",
        isDragging && "z-10 shadow-lg ring-1 ring-primary",
      )}
    >
      <span className="w-4 shrink-0 pt-0.5 text-right text-[11px] tabular-nums text-muted-foreground">
        {position}
      </span>
      <button
        type="button"
        ref={setActivatorNodeRef}
        className="-ml-0.5 shrink-0 cursor-grab touch-none rounded p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground active:cursor-grabbing"
        aria-label={`Reorder ${item.label}`}
        {...attributes}
        {...listeners}
      >
        <GripVertical className="size-4" />
      </button>
      <div className="min-w-0 flex-1">
        <p className="text-sm leading-snug">{item.label}</p>
        {item.description ? (
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{item.description}</p>
        ) : null}
      </div>
      {item.badge ? (
        <Badge variant="muted" className="mt-0.5 shrink-0">
          {item.badge}
        </Badge>
      ) : null}
    </li>
  );
}
