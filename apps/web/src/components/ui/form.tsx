import { useId, type ComponentProps, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Shared look for text inputs, selects and textareas (focus ring comes from :focus-visible). */
export const controlClass = cn(
  "w-full min-w-0 rounded-md border border-control/70 bg-field px-3 text-base text-asphalt shadow-[inset_0_1px_2px_#0000000d] outline-none transition-colors",
  "placeholder:text-steel/80 hover:border-control focus:border-asphalt",
  "aria-invalid:border-danger aria-invalid:bg-danger/5",
  "disabled:cursor-not-allowed disabled:opacity-60",
);

/** Hint or error under a control; the error carries an icon so it never relies on colour. */
export function FieldMessage({
  id,
  error,
  hint,
}: {
  id: string;
  error?: string | undefined;
  hint?: string | undefined;
}) {
  return (
    <>
      {hint && !error && (
        <p id={`${id}-hint`} className="text-sm text-steel">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-err`} className="flex items-start gap-1.5 text-sm font-medium text-danger">
          <svg viewBox="0 0 20 20" className="mt-0.5 size-4 shrink-0" aria-hidden="true">
            <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeWidth="2" />
            <path
              d="M10 6v5M10 13.5v.5"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
          {error}
        </p>
      )}
    </>
  );
}

function Wrap({
  id,
  label,
  error,
  hint,
  children,
}: {
  id: string;
  label: string;
  error?: string | undefined;
  hint?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-semibold">
        {label}
      </label>
      {children}
      <FieldMessage id={id} error={error} hint={hint} />
    </div>
  );
}

type Common = { label: string; error?: string | undefined; hint?: string | undefined };

export function SelectField({
  label,
  error,
  hint,
  className,
  children,
  ...props
}: ComponentProps<"select"> & Common) {
  const id = useId();
  return (
    <Wrap id={id} label={label} error={error} hint={hint}>
      <div className="relative">
        <select
          id={id}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-err` : hint ? `${id}-hint` : undefined}
          className={cn(controlClass, "h-11 cursor-pointer appearance-none pr-10", className)}
          {...props}
        >
          {children}
        </select>
        <svg
          viewBox="0 0 20 20"
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-steel"
        >
          <path
            d="M5.5 8l4.5 4.5L14.5 8"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
    </Wrap>
  );
}

export function TextAreaField({
  label,
  error,
  hint,
  className,
  ...props
}: ComponentProps<"textarea"> & Common) {
  const id = useId();
  return (
    <Wrap id={id} label={label} error={error} hint={hint}>
      <textarea
        id={id}
        rows={3}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-err` : hint ? `${id}-hint` : undefined}
        className={cn(controlClass, "py-2", className)}
        {...props}
      />
    </Wrap>
  );
}

export function CheckboxField({
  label,
  hint,
  ...props
}: ComponentProps<"input"> & { label: string; hint?: string }) {
  const id = useId();
  return (
    <div className="flex items-start gap-3">
      <input id={id} type="checkbox" className="mt-0.5 size-5 shrink-0 accent-hivis" {...props} />
      <div>
        <label htmlFor={id} className="font-semibold">
          {label}
        </label>
        {hint && <p className="text-sm text-steel">{hint}</p>}
      </div>
    </div>
  );
}
