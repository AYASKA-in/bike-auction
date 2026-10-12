import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";

export function NotFoundPage() {
  return (
    <section className="mx-auto max-w-6xl px-4 py-24 sm:px-6">
      <h1 className="font-expanded text-3xl font-extrabold">This page doesn't exist</h1>
      <p className="mt-3 text-steel">The link may be old, or the auction may have been removed.</p>
      <Button asChild className="mt-8">
        <Link to="/">Go to auctions</Link>
      </Button>
    </section>
  );
}
