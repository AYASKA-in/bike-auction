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
    <section className="mx-auto grid max-w-6xl gap-10 px-4 py-12 sm:px-6 lg:grid-cols-[minmax(0,26rem)_1fr] lg:py-20">
      <div>
        <h1 className="font-expanded text-3xl font-extrabold tracking-tight sm:text-4xl">
          {title}
        </h1>
        <p className="mt-3 text-steel">{intro}</p>
        <div className="mt-8">{children}</div>
      </div>
      {aside && <aside className="lg:pl-10">{aside}</aside>}
    </section>
  );
}
