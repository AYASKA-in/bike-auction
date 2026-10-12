import { Link, Outlet, useNavigate } from "@tanstack/react-router";
import { useMe, useSignOut } from "@/lib/session";
import { Button } from "./ui/button";
import { SystemFooter } from "./system-footer";

export function AppShell() {
  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-paper focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <header className="border-b border-rule bg-paper">
        <nav
          aria-label="Main"
          className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6"
        >
          <Link to="/" className="flex items-center gap-2.5" aria-label="Bike Auction home">
            <svg viewBox="0 0 32 32" className="size-8" aria-hidden="true">
              <rect width="32" height="32" rx="6" fill="#1D2125" />
              <path d="M9 21l8-11 2 3-5 8z" fill="#F25C05" />
              <circle cx="21" cy="21" r="3" fill="#F25C05" />
            </svg>
            <span className="font-expanded text-lg font-extrabold tracking-tight">
              Bike Auction
            </span>
          </Link>
          <ul className="ml-auto mr-2 flex items-center gap-1 text-sm font-medium">
            <li>
              <Link to="/" hash="auctions" className="rounded-md px-3 py-2 hover:bg-concrete">
                Auctions
              </Link>
            </li>
            <li className="hidden sm:block">
              <Link to="/" hash="how-it-works" className="rounded-md px-3 py-2 hover:bg-concrete">
                How bidding works
              </Link>
            </li>
          </ul>
          <AccountMenu />
        </nav>
      </header>
      <main id="main" className="flex-1">
        <Outlet />
      </main>
      <SystemFooter />
    </div>
  );
}

function AccountMenu() {
  const me = useMe();
  const signOut = useSignOut();
  const navigate = useNavigate();
  if (me.isPending) return <span className="h-11 w-24" aria-hidden="true" />;
  if (!me.data) {
    return (
      <Button asChild size="md" variant="secondary">
        <Link to="/login">Sign in</Link>
      </Button>
    );
  }
  return (
    <div className="flex items-center gap-2">
      {me.data.role === "ADMIN" && (
        <Link
          to="/admin"
          className="hidden rounded-md px-3 py-2 text-sm font-medium hover:bg-concrete sm:block"
        >
          Auction desk
        </Link>
      )}
      <span
        className="hidden max-w-[12ch] truncate text-sm font-semibold md:block"
        title={me.data.email}
      >
        {me.data.name}
      </span>
      <Button
        variant="ghost"
        onClick={() => signOut.mutate(undefined, { onSettled: () => void navigate({ to: "/" }) })}
        disabled={signOut.isPending}
      >
        Sign out
      </Button>
    </div>
  );
}
