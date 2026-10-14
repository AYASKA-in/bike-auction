import { Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ServerClockProvider } from "@/lib/server-time";
import { needsAction, purchasesQuery } from "@/lib/settlement";
import { useMe, useSignOut } from "@/lib/session";
import { SystemFooter } from "./system-footer";
import { Button } from "./ui/button";
import { CrossGlyph, MenuGlyph } from "./ui/icons";
import { ThemeToggle } from "./ui/theme-toggle";

export function AppShell() {
  return (
    <ServerClockProvider>
      <Shell />
    </ServerClockProvider>
  );
}

type NavItem = {
  to: "/auctions" | "/me/bids" | "/me/watchlist" | "/me/purchases" | "/admin";
  label: string;
  /** Count of things needing action (shown as a badge). */
  badge?: number;
};

function useNavItems(): NavItem[] {
  const me = useMe();
  const role = me.data?.role;
  const purchases = useQuery({
    ...purchasesQuery(me.data?.id ?? "-"),
    enabled: role === "USER",
  });
  const due = (purchases.data?.items ?? []).filter(needsAction).length;
  return [
    { to: "/auctions", label: "Auctions" },
    ...(role === "USER"
      ? ([
          { to: "/me/bids", label: "My bids" },
          { to: "/me/watchlist", label: "Watchlist" },
          { to: "/me/purchases", label: "Purchases", badge: due },
        ] as NavItem[])
      : []),
    ...(role === "ADMIN" ? ([{ to: "/admin", label: "Auction desk" }] as const) : []),
  ];
}

function Shell() {
  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:bg-asphalt focus:px-4 focus:py-3 focus:font-semibold focus:text-paper"
      >
        Skip to content
      </a>
      <Header />
      <main id="main" tabIndex={-1} className="flex-1 focus:outline-none">
        <Outlet />
      </main>
      <SystemFooter />
    </div>
  );
}

function Logo() {
  return (
    <Link
      to="/"
      className="-ml-1 flex min-h-11 items-center gap-2.5 rounded-md px-1"
      aria-label="Bike Auction home"
    >
      <svg viewBox="0 0 32 32" className="size-8 shrink-0" aria-hidden="true">
        <rect
          x=".5"
          y=".5"
          width="31"
          height="31"
          rx="7"
          className="fill-pit dark:stroke-white/20"
        />
        <path d="M9 21l8-11 2 3-5 8z" className="fill-hivis" />
        <circle cx="21" cy="21" r="3" className="fill-hivis" />
      </svg>
      <span className="hidden font-expanded text-[1.05rem] font-extrabold tracking-tight whitespace-nowrap min-[375px]:inline">
        Bike Auction
      </span>
    </Link>
  );
}

const navLink =
  "relative inline-flex min-h-11 items-center rounded-md px-3 text-sm font-semibold text-steel transition-colors hover:text-asphalt";
const navActive =
  "text-asphalt after:absolute after:inset-x-3 after:-bottom-[11px] after:h-0.5 after:rounded-full after:bg-hivis";

function Header() {
  const items = useNavItems();
  return (
    <header className="sticky top-0 z-30 border-b border-rule bg-paper/92 backdrop-blur-md supports-[not(backdrop-filter:blur(1px))]:bg-paper">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-4 px-4 sm:px-6">
        <Logo />
        {/* Desktop navigation */}
        <nav aria-label="Main" className="ml-4 hidden lg:block">
          <ul className="flex items-center gap-1">
            {items.map((l) => (
              <li key={l.to}>
                <Link to={l.to} className={navLink} activeProps={{ className: navActive }}>
                  {l.label}
                  {l.badge ? (
                    <span className="ml-1.5 inline-flex min-w-5 items-center justify-center rounded-full bg-hivis px-1.5 text-xs font-bold text-on-hivis tnum">
                      {l.badge}
                      <span className="sr-only"> need{l.badge === 1 ? "s" : ""} action</span>
                    </span>
                  ) : null}
                </Link>
              </li>
            ))}
            <li>
              <Link to="/" hash="how-it-works" className={navLink}>
                How bidding works
              </Link>
            </li>
          </ul>
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <ThemeToggle className="hidden lg:inline-flex" />
          <AccountArea />
          <MobileMenu items={items} />
        </div>
      </div>
    </header>
  );
}

function initials(name: string) {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase())
      .join("") || "?"
  );
}

function AccountArea() {
  const me = useMe();
  const signOut = useSignOut();
  const navigate = useNavigate();
  if (me.isPending) return <span className="hidden h-11 w-24 lg:block" aria-hidden="true" />;
  if (!me.data) {
    return (
      <Button asChild variant="secondary" className="whitespace-nowrap">
        <Link to="/login">Sign in</Link>
      </Button>
    );
  }
  return (
    <div className="hidden items-center gap-1 lg:flex">
      <Link
        to="/account"
        className="ml-2 flex min-h-11 items-center gap-2 rounded-md px-2 hover:bg-asphalt/8"
        title={`Account settings (${me.data.email})`}
      >
        <span
          aria-hidden="true"
          className="flex size-8 items-center justify-center rounded-full bg-asphalt text-xs font-bold text-paper"
        >
          {initials(me.data.name)}
        </span>
        <span className="max-w-[12ch] truncate text-sm font-semibold">{me.data.name}</span>
        <span className="sr-only">, account</span>
      </Link>
      <Button
        variant="ghost"
        loading={signOut.isPending}
        onClick={() => signOut.mutate(undefined, { onSettled: () => void navigate({ to: "/" }) })}
      >
        Sign out
      </Button>
    </div>
  );
}

/**
 * Small screens: one "Menu" disclosure instead of a crowded bar. Focus moves into the panel when
 * it opens; Esc or a click outside closes it and returns focus to the button; navigating closes it.
 */
function MobileMenu({ items }: { items: NavItem[] }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const href = useRouterState({ select: (s) => s.location.href });
  const me = useMe();
  const signOut = useSignOut();
  const navigate = useNavigate();

  const [seenHref, setSeenHref] = useState(href);
  if (href !== seenHref) {
    setSeenHref(href);
    if (open) setOpen(false);
  }

  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector<HTMLElement>("a, button")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    const onPointer = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!panelRef.current?.contains(t) && !buttonRef.current?.contains(t)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  return (
    <div className="lg:hidden">
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex min-h-11 items-center gap-2 rounded-md border border-rule bg-paper px-3 text-sm font-semibold hover:border-control"
      >
        {open ? <CrossGlyph className="size-4.5" /> : <MenuGlyph className="size-4.5" />}
        Menu
      </button>
      <div
        ref={panelRef}
        id={panelId}
        hidden={!open}
        className="menu-in absolute inset-x-0 top-full border-b border-rule bg-paper shadow-pop"
      >
        <nav aria-label="Main" className="mx-auto max-w-6xl px-4 pt-2 pb-4 sm:px-6">
          <ul className="divide-y divide-rule">
            {items.map((l) => (
              <li key={l.to}>
                <Link
                  to={l.to}
                  className="flex min-h-12 items-center justify-between text-base font-semibold"
                  activeProps={{
                    className: "text-hivis-ink",
                    "aria-current": "page",
                  }}
                >
                  {l.label}
                  {l.badge ? (
                    <span className="ml-1.5 inline-flex min-w-5 items-center justify-center rounded-full bg-hivis px-1.5 text-xs font-bold text-on-hivis tnum">
                      {l.badge}
                      <span className="sr-only"> need{l.badge === 1 ? "s" : ""} action</span>
                    </span>
                  ) : null}
                </Link>
              </li>
            ))}
            {me.data && (
              <li>
                <Link to="/account" className="flex min-h-12 items-center text-base font-semibold">
                  Account
                </Link>
              </li>
            )}
            <li>
              <Link
                to="/"
                hash="how-it-works"
                className="flex min-h-12 items-center text-base font-semibold"
              >
                How bidding works
              </Link>
            </li>
          </ul>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-rule pt-4">
            <p className="text-sm font-semibold text-steel">Theme</p>
            <ThemeToggle labels />
          </div>
          {me.data && (
            <div className="mt-4 flex items-center justify-between gap-3 border-t border-rule pt-4">
              <p className="min-w-0 text-sm">
                <span className="block truncate font-semibold">{me.data.name}</span>
                <span className="block truncate text-steel">{me.data.email}</span>
              </p>
              <Button
                variant="outline"
                loading={signOut.isPending}
                onClick={() =>
                  signOut.mutate(undefined, { onSettled: () => void navigate({ to: "/" }) })
                }
              >
                Sign out
              </Button>
            </div>
          )}
        </nav>
      </div>
    </div>
  );
}
