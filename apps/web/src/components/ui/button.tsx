import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

// shadcn/ui-style button, owned in-repo and themed to the project tokens. Every size keeps a
// 44 px minimum target. Primary is hi-vis orange with dark ink (white on orange fails contrast).
const buttonVariants = cva(
  "inline-flex select-none items-center justify-center gap-2 rounded-md text-center font-semibold transition-[background-color,border-color,color,box-shadow] duration-150 disabled:pointer-events-none disabled:opacity-55 aria-busy:cursor-progress",
  {
    variants: {
      variant: {
        primary:
          "bg-hivis text-on-hivis shadow-[inset_0_-2px_0_#0000001f] hover:bg-hivis-hover active:shadow-none",
        secondary: "bg-asphalt text-paper hover:bg-asphalt-2",
        outline: "border border-control/70 bg-paper text-asphalt hover:border-asphalt",
        ghost: "text-asphalt hover:bg-asphalt/8",
        danger: "bg-danger-solid text-white hover:brightness-110",
        /** Light button for the dark live panel (both themes). */
        onPit: "bg-pit-ink text-pit hover:bg-white",
      },
      size: {
        sm: "min-h-11 px-3 text-sm",
        md: "min-h-11 px-4 text-sm",
        lg: "min-h-12 px-6 text-base",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export function Button({
  className,
  variant,
  size,
  asChild = false,
  loading = false,
  disabled,
  children,
  ...props
}: ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean; loading?: boolean }) {
  if (asChild) {
    return (
      <Slot className={cn(buttonVariants({ variant, size }), className)} {...props}>
        {children}
      </Slot>
    );
  }
  return (
    <button
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 20 20"
      aria-hidden="true"
      className={cn("size-4 shrink-0 animate-spin motion-reduce:animate-none", className)}
    >
      <circle
        cx="10"
        cy="10"
        r="7.5"
        fill="none"
        stroke="currentColor"
        strokeOpacity=".3"
        strokeWidth="2.5"
      />
      <path
        d="M17.5 10a7.5 7.5 0 0 0-7.5-7.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
