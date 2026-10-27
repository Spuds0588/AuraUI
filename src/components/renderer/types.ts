import type { ComponentType } from "react";
import type { ComponentName, EventName } from "@/lib/protocol";

/**
 * The contract every task component implements.
 *
 * `props` is the validated payload the agent sent, narrowed to that component's interface.
 * A component never talks to the socket directly: it calls `respond` and the canvas decides
 * who hears about it.
 */
export interface TaskComponentProps<P = unknown> {
  /** The task this component is answering, echoed back with every event. */
  taskId: string;
  /** Agent-supplied props, already validated by the bridge. */
  props: P;
  /**
   * Report an answer up to the agent.
   *
   * Terminal events (`action`, `submit`, `filter`, `cancel`) close the card. Non-terminal
   * ones (`select`, `change`, `sort`) are recorded on the card and forwarded, so an agent
   * can watch a grid selection settle before the human commits.
   */
  respond: (event: EventName, payload?: unknown) => void;
  /** True once the task is answered or withdrawn: render read-only, no controls. */
  resolved: boolean;
}

/**
 * A component erased to its widest props type, so the registry can hold a heterogeneous
 * map. Each component is written against its own narrow `TaskComponentProps<X>` and cast
 * once at the registry boundary — the alternatative is a discriminated-union props type
 * that no component can actually implement.
 */
export type TaskComponent = ComponentType<TaskComponentProps<never>>;

/** Registry entry: how to draw a component and how to describe it. */
export interface TaskRenderer {
  component: TaskComponent;
  /** Short label for the card header chip. */
  label: string;
  /** One-line hint shown when a task is the only thing on the canvas. */
  hint?: string;
  /**
   * Wants the card to take the wide column rather than the conversation-sized one.
   *
   * The canvas is built around a card the width of a question, and every component so far fits
   * that. A delegated web task and a signature request do not: one shows a real page and the other
   * shows a document, and neither can be read three hundred pixels at a time.
   */
  wide?: boolean;
}

export type RendererRegistry = Record<ComponentName, TaskRenderer>;
