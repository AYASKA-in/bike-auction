import type { ReactNode } from "react";

/** Shared frame for sign-in and registration: form on the left, context on the right. */
export function AuthFrame({
  title,
  intro,
  children,
  aside,
}: {
  title: string;
  intro: string;
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <section className="mx-auto grid max-w-6xl gap-8 px-4 pt-8 pb-14 sm:px-6 sm:pt-12 lg:grid-cols-[minmax(0,28rem)_1fr] lg:gap-14 lg:pt-16">
      <div className="min-w-0">
        <h1 className="font-expanded text-3xl leading-tight font-extrabold tracking-tight sm:text-4xl">
          {title}
        </h1>
        <p className="mt-1.5 text-steel">{intro}</p>
        <div className="mt-6 rounded-xl border border-rule bg-paper p-5 shadow-card sm:p-6">
          {children}
        </div>
      </div>
      {aside && <aside className="min-w-0 lg:pt-[5.5rem]">{aside}</aside>}
    </section>
  );
}
