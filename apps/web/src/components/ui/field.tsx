import { useId, useState, type ComponentProps } from "react";
import { cn } from "@/lib/utils";

type FieldProps = ComponentProps<"input"> & {
  label: string;
  error?: string | undefined;
  hint?: string;
};

/** Labelled input with error/hint wired to aria-describedby. */
export function Field({ label, error, hint, className, type, ...props }: FieldProps) {
  const id = useId();
  const [reveal, setReveal] = useState(false);
  const isPassword = type === "password";
  const describedBy =
    [error ? `${id}-err` : null, hint ? `${id}-hint` : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-semibold">
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          type={isPassword && reveal ? "text" : type}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={cn(
            "h-11 w-full rounded-md border border-steel/40 bg-white px-3 text-base outline-none transition-colors",
            "focus:border-asphalt aria-invalid:border-danger",
            isPassword && "pr-20",
            className,
          )}
          {...props}
        />
        {isPassword && (
          <button
            type="button"
            onClick={() => setReveal((r) => !r)}
            className="absolute inset-y-1 right-1 rounded px-3 text-sm font-medium text-steel hover:bg-concrete"
            aria-pressed={reveal}
          >
            {reveal ? "Hide" : "Show"}
          </button>
        )}
      </div>
      {hint && !error && (
        <p id={`${id}-hint`} className="text-sm text-steel">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-err`} className="text-sm font-medium text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
