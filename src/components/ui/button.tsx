import type { ButtonHTMLAttributes } from "react";

import { cn } from "@/lib/utils";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "ghost";
};

export function Button({ className, variant = "default", ...props }: ButtonProps) {
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center rounded-full border px-4 py-2 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:pointer-events-none disabled:opacity-50",
        variant === "default"
          ? "border-accent bg-accent text-accent-foreground hover:bg-accent/90"
          : "border-border bg-transparent text-foreground hover:border-accent/40 hover:bg-accent/8",
        className,
      )}
      {...props}
    />
  );
}
