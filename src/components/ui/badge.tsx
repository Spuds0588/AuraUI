import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium leading-tight",
  {
    variants: {
      variant: {
        default: "bg-secondary text-secondary-foreground",
        muted: "bg-muted text-muted-foreground",
        primary: "bg-primary/15 text-primary",
        accent: "bg-accent/15 text-accent",
        success: "bg-emerald-500/15 text-emerald-400",
        warn: "bg-amber-500/15 text-amber-400",
        danger: "bg-destructive/15 text-destructive",
        outline: "border border-border text-muted-foreground",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { badgeVariants };
