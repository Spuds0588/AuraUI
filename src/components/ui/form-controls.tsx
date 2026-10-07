import * as React from "react";
import { Label as LabelPrimitive } from "@radix-ui/react-label";
import { cn } from "@/lib/utils";

/**
 * Text-shaped fields, and nothing that presents a choice.
 *
 * Choosing belongs to `ChoiceButtons`: AuraUI has no checkboxes, radio buttons or dropdowns,
 * so there is no primitive here for one. What is left is the two things a human really does
 * type (a line, or a paragraph) and the shell every field shares.
 */

const fieldRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        "flex h-10 w-full rounded-lg border border-input bg-background/60 px-3.5 py-1.5 text-sm shadow-sm transition-colors placeholder:text-muted-foreground",
        fieldRing,
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      "flex min-h-[96px] w-full rounded-lg border border-input bg-background/60 px-3.5 py-2.5 text-sm shadow-sm transition-colors placeholder:text-muted-foreground",
      fieldRing,
      className,
    )}
    {...props}
  />
));
Textarea.displayName = "Textarea";

export const Label = React.forwardRef<
  React.ComponentRef<typeof LabelPrimitive>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive>
>(({ className, ...props }, ref) => (
  <LabelPrimitive
    ref={ref}
    className={cn("text-xs font-medium text-foreground", className)}
    {...props}
  />
));
Label.displayName = "Label";

/** Label + control + help/error, so every field in a form lines up the same way. */
export function FieldShell({
  id,
  label,
  help,
  error,
  required,
  children,
  className,
}: {
  id?: string;
  label: string;
  help?: string;
  error?: string;
  required?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <Label htmlFor={id}>
        {label}
        {required ? <span className="ml-0.5 text-destructive">*</span> : null}
      </Label>
      {children}
      {error ? (
        <p className="text-[11px] leading-relaxed text-destructive">{error}</p>
      ) : help ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground">{help}</p>
      ) : null}
    </div>
  );
}
