import { useId, type ComponentProps, type ReactNode } from "react";
import { cn } from "@/lib/utils";

const control =
  "w-full rounded-md border border-steel/40 bg-white px-3 text-base outline-none transition-colors focus:border-asphalt aria-invalid:border-danger";

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
      <select
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-err` : hint ? `${id}-hint` : undefined}
        className={cn(control, "h-11", className)}
        {...props}
      >
        {children}
      </select>
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
        className={cn(control, "py-2", className)}
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
      <input id={id} type="checkbox" className="mt-1 size-5 accent-hivis" {...props} />
      <div>
        <label htmlFor={id} className="font-semibold">
          {label}
        </label>
        {hint && <p className="text-sm text-steel">{hint}</p>}
      </div>
    </div>
  );
}
