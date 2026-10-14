import { cn } from "@/lib/utils";

/** One tab look for the whole app (catalogue status, My bids): underline in hi-vis when selected. */
export const tabListClass =
  "flex gap-1 overflow-x-auto border-b border-rule [scrollbar-width:none] [&::-webkit-scrollbar]:hidden";

export function tabClass(selected: boolean) {
  return cn(
    "relative -mb-px inline-flex min-h-11 shrink-0 items-center gap-2 whitespace-nowrap border-b-2 px-3.5 text-sm font-semibold transition-colors sm:px-4",
    selected
      ? "border-hivis text-asphalt"
      : "border-transparent text-steel hover:border-control/50 hover:text-asphalt",
  );
}

/** Toggle chip (filters, presets): pressed = inverse ink. */
export function chipClass(pressed: boolean) {
  return cn(
    "inline-flex min-h-11 items-center gap-1.5 rounded-full border px-3.5 text-sm font-semibold transition-colors",
    pressed
      ? "border-asphalt bg-asphalt text-paper"
      : "border-control/50 bg-paper text-asphalt hover:border-asphalt",
  );
}
