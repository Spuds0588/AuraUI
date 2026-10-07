import type { ComponentName } from "@/lib/protocol";
import type { RendererRegistry, TaskComponent, TaskRenderer } from "./types";

import ActionCard from "@/components/tasks/ActionCard";
import Notice from "@/components/tasks/Notice";
import WizardForm from "@/components/tasks/WizardForm";
import SortableList from "@/components/tasks/SortableList";
import DataGrid from "@/components/tasks/DataGrid";
import InteractiveChart from "@/components/tasks/InteractiveChart";
import RatingScale from "@/components/tasks/RatingScale";
import DiffReview from "@/components/tasks/DiffReview";

/**
 * The one place that knows which React component draws which protocol component.
 *
 * Each task component is written against its own narrow props type
 * (`TaskComponentProps<ActionCardProps>`) and is widened once here. A component that
 * accepts narrower props is assignable to one accepting `never`, so this is a genuine
 * widening rather than an unsafe cast.
 */
export const REGISTRY: RendererRegistry = {
  ActionCard: {
    component: ActionCard as TaskComponent,
    label: "Choice",
    hint: "One click decides the next step.",
  },
  Notice: {
    component: Notice as TaskComponent,
    label: "Notice",
    hint: "Information with optional follow-up actions.",
  },
  WizardForm: {
    component: WizardForm as TaskComponent,
    label: "Form",
    hint: "Structured questions, answered in steps.",
  },
  SortableList: {
    component: SortableList as TaskComponent,
    label: "Ordering",
    hint: "Drag the items into the order you want.",
  },
  DataGrid: {
    component: DataGrid as TaskComponent,
    label: "Table",
    hint: "Sort, filter and pick the row that matters.",
  },
  InteractiveChart: {
    component: InteractiveChart as TaskComponent,
    label: "Chart",
    hint: "Click into the data to drill down.",
  },
  RatingScale: {
    component: RatingScale as TaskComponent,
    label: "Rating",
    hint: "Press the point on the scale that fits.",
  },
  DiffReview: {
    component: DiffReview as TaskComponent,
    label: "Review",
    hint: "Accept or reject each hunk of a change.",
  },
};

export function rendererFor(name: ComponentName): TaskRenderer | undefined {
  return REGISTRY[name];
}
