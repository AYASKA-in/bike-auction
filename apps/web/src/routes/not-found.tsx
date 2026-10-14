import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { EmptyBayArt } from "@/components/ui/empty-state";

export function NotFoundPage() {
  return (
    <section className="mx-auto grid max-w-6xl items-center gap-10 px-4 py-16 sm:px-6 lg:grid-cols-[1fr_auto] lg:py-24">
      <div className="max-w-xl">
        <p className="font-expanded text-sm font-bold text-hivis-ink tnum">Error 404</p>
        <h1 className="mt-2 font-expanded text-3xl leading-tight font-extrabold tracking-tight sm:text-4xl">
          This page doesn't exist
        </h1>
        <p className="mt-4 text-lg text-steel">
          The link may be old or mistyped, or the auction may have been withdrawn. Live and upcoming
          auctions are all on the auctions page.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Button asChild size="lg">
            <Link to="/auctions">Browse auctions</Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link to="/">Go to the home page</Link>
          </Button>
        </div>
        <p className="mt-8 text-sm text-steel">
          Looking for a bid you placed?{" "}
          <Link to="/me/bids" className="font-semibold text-asphalt underline underline-offset-4">
            Open My bids
          </Link>
        </p>
      </div>
      <EmptyBayArt className="w-56 justify-self-center sm:w-72" />
    </section>
  );
}
