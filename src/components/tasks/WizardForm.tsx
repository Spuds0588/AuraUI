import { useCallback, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  Badge,
  Button,
  ChoiceButtons,
  type ChoiceOption,
  FieldShell,
  Input,
  Textarea,
} from "@/components/ui";
import type { TaskComponentProps } from "@/components/renderer/types";
import type { Field, WizardFormProps, WizardStep } from "@/lib/protocol";
import { cn } from "@/lib/utils";

type Values = Record<string, unknown>;
type Errors = Record<string, string>;

/**
 * The field kinds this canvas can draw.
 *
 * A `string` set rather than the union, because the value being checked comes off a socket:
 * an agent written against an older contract can still send `radio`, and that has to be
 * reported rather than typed away.
 */
const FIELD_KINDS = new Set<string>(["text", "textarea", "number", "date", "choice", "multi"]);

function seedValues(steps: WizardStep[]): Values {
  const values: Values = {};
  for (const step of steps) {
    for (const field of step.fields ?? []) {
      // Seeding every field keeps the inputs controlled from the first render, so a
      // defaultValue the agent sent is what the human actually sees.
      if (field.type === "multi") {
        // A `multi` is the one field that holds a list, and `ChoiceButtons` reads it as one.
        values[field.name] = Array.isArray(field.defaultValue) ? field.defaultValue : [];
        continue;
      }
      values[field.name] = field.defaultValue !== undefined ? field.defaultValue : "";
    }
  }
  return values;
}

function textOf(value: unknown): string {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : String(value);
}

/** One field's rules. Returns the message to show, or undefined when it passes. */
function validateField(field: Field, value: unknown): string | undefined {
  const rule = field.validate;

  if (field.required) {
    if (field.type === "multi") {
      if (!Array.isArray(value) || value.length === 0) {
        return rule?.message ?? `${field.label} needs at least one choice.`;
      }
    } else if (textOf(value).trim() === "") {
      return rule?.message ?? `${field.label} is required.`;
    }
  }

  // A list of choices has no text to pattern-match or measure, and its own rule was handled
  // above, so the string rules below do not apply to it.
  if (field.type === "multi") return undefined;

  const text = textOf(value);

  if (rule?.pattern && text !== "") {
    try {
      if (!new RegExp(rule.pattern).test(text)) {
        return rule.message ?? `${field.label} is not in the expected format.`;
      }
    } catch {
      // An agent that ships a broken regex must not take the whole form down with it.
    }
  }

  if (rule?.minLength !== undefined && text !== "" && text.length < rule.minLength) {
    return rule.message ?? `${field.label} needs at least ${rule.minLength} characters.`;
  }
  if (rule?.maxLength !== undefined && text.length > rule.maxLength) {
    return rule.message ?? `${field.label} allows at most ${rule.maxLength} characters.`;
  }

  if (field.type === "number" && text.trim() !== "") {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return `${field.label} must be a number.`;
    if (field.min !== undefined && numeric < field.min) {
      return `${field.label} must be at least ${field.min}.`;
    }
    if (field.max !== undefined && numeric > field.max) {
      return `${field.label} must be at most ${field.max}.`;
    }
  }

  return undefined;
}

function validateStep(step: WizardStep, values: Values): Errors {
  const errors: Errors = {};
  for (const field of step.fields ?? []) {
    const message = validateField(field, values[field.name]);
    if (message) errors[field.name] = message;
  }
  return errors;
}

function displayValue(field: Field, value: unknown): string {
  if (field.type === "choice" || field.type === "multi") {
    // Read back the labels the human actually clicked. A receipt saying "sev_1" would be
    // worse than no receipt, and the labels are the only words they ever saw.
    const labels = new Map((field.options ?? []).map((option) => [option.value, option.label]));
    const chosen = Array.isArray(value)
      ? value
      : value === undefined || value === null || value === ""
        ? []
        : [value];
    const named = chosen
      .map((entry) => labels.get(String(entry)) ?? String(entry))
      .filter((entry) => entry !== "");
    return named.length > 0 ? named.join(", ") : "—";
  }
  if (value === undefined || value === null || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

/**
 * A real multi-step form.
 *
 * Validation is enforced in the UI as well as on the agent side, because a form that lets
 * you submit a missing required field just moves the failure somewhere the human cannot
 * see it. Steps are also free to be jumped between once they validate, which is how people
 * actually fill these in.
 */
export default function WizardForm({
  taskId,
  props,
  respond,
  resolved,
}: TaskComponentProps<WizardFormProps>) {
  const steps = useMemo<WizardStep[]>(
    () => (Array.isArray(props?.steps) ? props.steps : []),
    [props],
  );
  const [values, setValues] = useState<Values>(() => seedValues(steps));
  const [stepIndex, setStepIndex] = useState(0);
  const [errors, setErrors] = useState<Errors>({});
  const [submitted, setSubmitted] = useState(false);

  const total = steps.length;
  const safeIndex = Math.min(stepIndex, Math.max(total - 1, 0));
  const step = steps[safeIndex];
  const isLast = safeIndex >= total - 1;
  const locked = submitted || resolved;
  const live = props?.live === true;

  const setValue = useCallback(
    (field: Field, value: unknown) => {
      setValues((current) => ({ ...current, [field.name]: value }));
      // Clear this field's error as soon as the human edits it, rather than nagging.
      setErrors((current) => {
        if (!(field.name in current)) return current;
        const next = { ...current };
        delete next[field.name];
        return next;
      });
      if (live) respond("change", { name: field.name, value });
    },
    [live, respond],
  );

  /**
   * One button array, shared by `choice` and `multi`.
   *
   * The only difference between the two is whether picking an option clears the others, so
   * they render the same control with the same hit target and the same keyboard story. The
   * toggle rule below is where that difference lives, and nowhere else.
   */
  const choiceControl = (field: Field, value: unknown, multi: boolean) => {
    const options: ChoiceOption[] = field.options ?? [];

    if (options.length === 0) {
      return (
        <p className="rounded-lg border border-dashed border-border bg-secondary/20 px-4 py-2.5 text-xs text-muted-foreground">
          This field arrived with no options to choose from, so there is nothing to click.
        </p>
      );
    }

    const current = multi
      ? Array.isArray(value)
        ? value.map(String)
        : []
      : textOf(value) === ""
        ? []
        : [textOf(value)];

    return (
      <ChoiceButtons
        ariaLabel={field.label}
        options={options}
        value={current}
        disabled={locked}
        onToggle={(next) => {
          if (!multi) {
            // Re-clicking the answer that is already on keeps it: picking again is not
            // the same thing as taking the answer back.
            setValue(field, next);
            return;
          }
          setValue(
            field,
            current.includes(next)
              ? current.filter((entry) => entry !== next)
              : [...current, next],
          );
        }}
      />
    );
  };

  function renderField(field: Field) {
    const id = `${taskId}-${field.name}`;
    const value = values[field.name];
    const error = errors[field.name];

    // A field this canvas cannot draw has to say so. Falling through to the text input at
    // the end of the chain below would turn a question nothing here can answer into one that
    // looks answerable, and the human would send back a string the agent never asked for.
    if (!FIELD_KINDS.has(field.type)) {
      return (
        <FieldShell
          key={field.name}
          id={id}
          label={field.label}
          required={field.required}
          help={`This field asks for a "${String(field.type)}" control, which this canvas cannot draw.`}
        >
          <p className="rounded-lg border border-dashed border-border bg-secondary/20 px-4 py-2.5 text-xs text-muted-foreground">
            Nothing here can answer it. Ask the agent to resend it as a choice, a multi, or text.
          </p>
        </FieldShell>
      );
    }

    return (
      <FieldShell
        key={field.name}
        id={id}
        label={field.label}
        help={field.help}
        error={error}
        required={field.required}
      >
        {field.type === "textarea" ? (
          <Textarea
            id={id}
            value={textOf(value)}
            placeholder={field.placeholder}
            disabled={locked}
            aria-invalid={Boolean(error)}
            onChange={(event) => setValue(field, event.target.value)}
          />
        ) : field.type === "choice" ? (
          choiceControl(field, value, false)
        ) : field.type === "multi" ? (
          choiceControl(field, value, true)
        ) : field.type === "number" ? (
          <Input
            id={id}
            type="number"
            value={textOf(value)}
            min={field.min}
            max={field.max}
            step={field.step}
            placeholder={field.placeholder}
            disabled={locked}
            aria-invalid={Boolean(error)}
            onChange={(event) => setValue(field, event.target.value)}
          />
        ) : field.type === "date" ? (
          <Input
            id={id}
            type="date"
            value={textOf(value)}
            disabled={locked}
            aria-invalid={Boolean(error)}
            onChange={(event) => setValue(field, event.target.value)}
          />
        ) : (
          <Input
            id={id}
            type="text"
            value={textOf(value)}
            placeholder={field.placeholder}
            disabled={locked}
            aria-invalid={Boolean(error)}
            onChange={(event) => setValue(field, event.target.value)}
          />
        )}
      </FieldShell>
    );
  }

  if (total === 0 || !step) {
    return (
      <p className="text-xs text-muted-foreground">
        This form arrived with no steps, so there is nothing to ask.
      </p>
    );
  }

  if (resolved) {
    return (
      <div className="flex flex-col gap-3">
        {steps.map((entry) => (
          <div
            key={entry.id}
            className="rounded-lg border border-border/60 bg-secondary/20 p-4"
          >
            <p className="mb-2.5 text-xs font-semibold text-foreground">{entry.title}</p>
            <dl className="flex flex-col gap-1.5">
              {(entry.fields ?? []).map((field) => (
                <div key={field.name} className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
                  <dt className="text-muted-foreground">{field.label}</dt>
                  <dd className="font-medium text-foreground/90">
                    {displayValue(field, values[field.name])}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
    );
  }

  const goNext = () => {
    const found = validateStep(step, values);
    if (Object.keys(found).length > 0) {
      setErrors(found);
      return;
    }
    setErrors({});
    setStepIndex(Math.min(safeIndex + 1, total - 1));
  };

  const goBack = () => {
    setErrors({});
    setStepIndex(Math.max(safeIndex - 1, 0));
  };

  const submit = () => {
    // Re-check every step, not just the visible one: the human can navigate back, and the
    // agent's rules still apply to what they already typed.
    for (let index = 0; index < total; index += 1) {
      const found = validateStep(steps[index], values);
      if (Object.keys(found).length > 0) {
        setStepIndex(index);
        setErrors(found);
        return;
      }
    }
    setErrors({});
    setSubmitted(true);

    // Per-step snapshots, so an agent can tell which step a value came from even when two
    // steps happen to reuse a field name.
    const perStep: Array<{ stepId: string; values: Values }> = [];
    const running: Values = {};
    for (const entry of steps) {
      for (const field of entry.fields ?? []) running[field.name] = values[field.name];
      perStep.push({ stepId: entry.id, values: { ...running } });
    }

    respond("submit", { component: "WizardForm", values, steps: perStep });
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <Badge variant="muted">
          Step {safeIndex + 1} of {total}
        </Badge>
        <ol className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px]">
          {steps.map((entry, index) => (
            <li key={entry.id} className="flex items-center gap-1.5">
              {index > 0 ? (
                <ChevronRight aria-hidden="true" className="size-3 opacity-50" />
              ) : null}
              <button
                type="button"
                onClick={() => {
                  setErrors({});
                  setStepIndex(index);
                }}
                aria-current={index === safeIndex ? "step" : undefined}
                className={cn(
                  "rounded px-1.5 py-1 hover:bg-secondary/60",
                  index === safeIndex ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {entry.title}
              </button>
            </li>
          ))}
        </ol>
      </div>

      <div className="flex flex-col gap-4">
        {step.description ? (
          <p className="text-xs text-muted-foreground">{step.description}</p>
        ) : null}
        {(step.fields ?? []).map((field) => renderField(field))}
        {(step.fields ?? []).length === 0 ? (
          <p className="text-xs text-muted-foreground">
            This step has no fields. Continue when you are ready.
          </p>
        ) : null}
      </div>

      <div className="flex items-center gap-3">
        {safeIndex > 0 ? (
          <Button type="button" variant="outline" size="sm" onClick={goBack} disabled={locked}>
            <ChevronLeft aria-hidden="true" />
            Back
          </Button>
        ) : null}
        <div className="ml-auto flex items-center gap-3">
          {isLast ? (
            <Button type="button" variant="primary" size="sm" onClick={submit} disabled={locked}>
              {props?.submitLabel ?? "Submit"}
            </Button>
          ) : (
            <Button type="button" variant="primary" size="sm" onClick={goNext} disabled={locked}>
              Next
              <ChevronRight aria-hidden="true" />
            </Button>
          )}
        </div>
      </div>

      {submitted ? (
        <p className="text-[11px] text-muted-foreground">Sent. Waiting for the agent.</p>
      ) : null}
    </div>
  );
}
