import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

// shadcn/ui-style button, owned in-repo and themed to the project tokens.
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-md font-semibold transition-colors disabled:pointer-events-none disabled:opacity-50 min-h-11",
  {
    variants: {
      variant: {
        primary: "bg-hivis text-white hover:bg-hivis-ink",
        secondary: "bg-asphalt text-paper hover:bg-asphalt-2",
        ghost: "text-asphalt hover:bg-rule/60",
      },
      size: { md: "px-4 text-sm", lg: "px-6 text-base" },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "button";
  return <Comp className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
