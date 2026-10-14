import { Link } from "@tanstack/react-router";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api";

/** Friendly failure panel with the request id (for support) and a retry. */
export function PageError({
  title,
  message,
  error,
  onRetry,
}: {
  title: string;
  message: string;
  error: unknown;
  onRetry: () => void;
}) {
  const requestId = error instanceof ApiError ? error.requestId : undefined;
  return (
    <section role="alert" className="mx-auto max-w-xl px-4 py-24 sm:px-6">
      <h1 className="font-expanded text-3xl font-extrabold">{title}</h1>
      <p className="mt-3 text-steel">{message}</p>
      {requestId && (
        <p className="mt-3 text-sm text-steel">
          If this keeps happening, quote reference{" "}
          <code className="rounded bg-concrete px-1.5 py-0.5 font-mono text-asphalt select-all">
            {requestId}
          </code>
          .
        </p>
      )}
      <div className="mt-6 flex flex-wrap items-center gap-4">
        <Button type="button" size="lg" onClick={onRetry}>
          Try again
        </Button>
        <Link
          to="/auctions"
          className="inline-flex min-h-11 items-center font-semibold underline underline-offset-4"
        >
          Browse auctions
        </Link>
      </div>
    </section>
  );
}

type Props = { children: ReactNode; onRetry: () => void };
type State = { error: unknown; failed: boolean };

/**
 * Error boundary for the live auction page: a render error never blanks the screen. Bidding state
 * lives on the server, so "Try again" (re-fetch + re-render) is always safe.
 */
export class LiveErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, failed: false };

  static getDerivedStateFromError(error: unknown): State {
    return { error, failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error("auction page crashed", error, info.componentStack);
  }

  private retry = () => {
    this.props.onRetry();
    this.setState({ error: null, failed: false });
  };

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <PageError
        title="Something went wrong on this page"
        message="Your bids are safe: a bid only counts once the server confirms it. Try again to reload the auction."
        error={this.state.error}
        onRetry={this.retry}
      />
    );
  }
}
