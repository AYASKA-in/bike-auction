import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useId, useState, type ReactNode } from "react";
import { Alert, Callout } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { LoadError } from "@/components/ui/empty-state";
import { Field } from "@/components/ui/field";
import { Card, PageHeader } from "@/components/ui/page";
import { Skeleton } from "@/components/ui/skeleton";
import {
  accountErrorMessage,
  accountQuery,
  blockerLabel,
  confirmationMatches,
  deletionBlockers,
  downloadMyData,
  NOTICE_PURPOSES,
  NOTICE_RETENTION,
  NOTICE_VERSION,
  useDeleteAccount,
} from "@/lib/account";
import { formatIST } from "@/lib/format";
import { useMe } from "@/lib/session";

function Panel({
  title,
  children,
  id,
  tone,
}: {
  title: string;
  children: ReactNode;
  id?: string;
  tone?: "danger";
}) {
  return (
    <Card id={id} title={title} className={tone === "danger" ? "border-danger/40" : undefined}>
      <div className="text-sm leading-relaxed text-steel">{children}</div>
    </Card>
  );
}

/** /account (signed in): details, privacy information, export, deletion. */
export function AccountPage() {
  const me = useMe();
  const userId = me.data?.id ?? "-";
  const account = useQuery({ ...accountQuery(userId), enabled: Boolean(me.data) });
  const ids = { details: useId(), privacy: useId(), data: useId(), del: useId() };

  return (
    <section className="mx-auto max-w-3xl px-4 pt-8 pb-14 sm:px-6 sm:pt-10">
      <PageHeader
        title="Account & privacy"
        description="Your details, how we use your data, a copy of it, and closing your account."
      />

      <div className="mt-6 flex flex-col gap-5">
        <Panel title="Your details" id={ids.details}>
          {account.isPending ? (
            <div className="space-y-2" aria-busy="true">
              <Skeleton className="h-5 w-2/3" />
              <Skeleton className="h-5 w-1/2" />
              <Skeleton className="h-5 w-3/5" />
            </div>
          ) : account.isError ? (
            <LoadError
              className="py-6"
              title="Couldn't load your details."
              onRetry={() => void account.refetch()}
            />
          ) : (
            <dl
              className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-y-3 [&>dd]:mb-2 sm:[&>dd]:mb-0"
              data-testid="account-details"
            >
              <dt className="font-semibold text-asphalt">Name</dt>
              <dd>{account.data.name}</dd>
              <dt className="font-semibold text-asphalt">Email</dt>
              <dd className="break-all">{account.data.email}</dd>
              <dt className="font-semibold text-asphalt">Member since</dt>
              <dd>{account.data.createdAt ? formatIST(account.data.createdAt) : "—"}</dd>
              <dt className="font-semibold text-asphalt">Consent</dt>
              <dd>
                {account.data.consents.length === 0
                  ? "No sign-up consent on record (operator-created demo account)."
                  : account.data.consents.map((c) => (
                      <span key={`${c.purpose}-${c.at}`} className="block">
                        Privacy Notice version {c.version}, given {formatIST(c.at)}
                      </span>
                    ))}
              </dd>
            </dl>
          )}
        </Panel>

        <Panel title="How we use your data" id={ids.privacy}>
          <ul className="flex list-disc flex-col gap-1 pl-5">
            {NOTICE_PURPOSES.map((p) => (
              <li key={p.title}>
                <span className="font-semibold text-asphalt">{p.title}.</span> {p.body}
              </li>
            ))}
          </ul>
          <p className="mt-3">
            Read the full{" "}
            <Link to="/privacy" className="font-semibold text-asphalt underline underline-offset-4">
              Privacy Notice
            </Link>{" "}
            (version {NOTICE_VERSION}), including how long we keep each kind of data.
          </p>
        </Panel>

        <ExportPanel id={ids.data} />
        {me.data && (
          <DeletePanel id={ids.del} email={me.data.email} isAdmin={me.data.role === "ADMIN"} />
        )}
      </div>
    </section>
  );
}

function ExportPanel({ id }: { id: string }) {
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const [error, setError] = useState<string | null>(null);
  return (
    <Panel title="Download my data" id={id}>
      <p>
        A JSON file with your account, consent history, watchlist, the auctions you bid in, your own
        maximum bids and the security events linked to your account. It never contains other
        bidders' details.
      </p>
      {error && (
        <div className="mt-3">
          <Alert>{error}</Alert>
        </div>
      )}
      <Button
        className="mt-4"
        variant="secondary"
        loading={state === "busy"}
        onClick={() => {
          setError(null);
          setState("busy");
          downloadMyData()
            .then(() => setState("done"))
            .catch((err: unknown) => {
              setError(accountErrorMessage(err));
              setState("idle");
            });
        }}
      >
        {state === "busy" ? "Preparing…" : "Download my data"}
      </Button>
      {state === "done" && (
        <p className="mt-2 font-semibold text-ledger" role="status">
          Your download has started.
        </p>
      )}
    </Panel>
  );
}

function DeletePanel({ id, email, isAdmin }: { id: string; email: string; isAdmin: boolean }) {
  const navigate = useNavigate();
  const del = useDeleteAccount();
  const [typed, setTyped] = useState("");
  const blockers = deletionBlockers(del.error);
  const ready = confirmationMatches(typed, email);

  return (
    <Panel title="Delete my account" id={id} tone="danger">
      <p>
        Deleting signs you out everywhere and erases your name, email, password, sessions, watchlist
        and consent records. It can't be undone.
      </p>
      <h3 className="mt-4 font-semibold text-asphalt">What we keep, and why</h3>
      <ul className="mt-1 flex list-disc flex-col gap-1 pl-5">
        <li>
          Each auction's bid record stays, because the auction's result must remain verifiable for
          the other bidders and the seller. It refers to an internal account number, never your name
          or email, and other bidders only ever saw a per-auction code.
        </li>
        <li>Security logs linked to the account are kept for one year, then deleted.</li>
        <li>
          A minimal note that an account was deleted (no name, no email) is kept for one year.
        </li>
      </ul>
      <p className="mt-3">
        You can't delete your account while you have the highest bid or an active maximum bid in a
        live auction, or for 30 days after winning one.
      </p>

      {isAdmin ? (
        <Callout tone="info" className="mt-4 text-asphalt">
          Administrator accounts are closed by an operator, not from this page.
        </Callout>
      ) : (
        <form
          className="mt-5 flex flex-col gap-4 border-t border-rule pt-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (!ready) return;
            del.mutate(typed, {
              onSuccess: () => void navigate({ to: "/", replace: true }),
            });
          }}
        >
          {del.isError && (
            <Alert>
              {accountErrorMessage(del.error)}
              {blockers.length > 0 && (
                <ul className="mt-2 flex flex-col gap-1">
                  {blockers.map((b) => (
                    <li key={b.auctionId}>
                      <Link
                        to="/auctions/$auctionId"
                        params={{ auctionId: b.auctionId }}
                        className="font-semibold underline underline-offset-4"
                      >
                        {b.title ?? "Auction"}
                      </Link>
                      : {blockerLabel(b)}
                    </li>
                  ))}
                </ul>
              )}
            </Alert>
          )}
          <Field
            label={`Type your email (${email}) to confirm`}
            type="email"
            autoComplete="off"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            data-testid="delete-confirm"
          />
          <Button
            type="submit"
            variant="danger"
            disabled={!ready}
            loading={del.isPending}
            className="self-start"
          >
            {del.isPending ? "Deleting…" : "Delete my account permanently"}
          </Button>
        </form>
      )}
    </Panel>
  );
}

/** /privacy (public): the Privacy Notice linked from sign-up. */
export function PrivacyPage() {
  return (
    <section className="mx-auto max-w-3xl px-4 pt-8 pb-14 sm:px-6 sm:pt-10">
      <PageHeader
        title="Privacy Notice"
        description="This is a demonstration auction service. This notice explains, in plain language, what personal data we collect, why, how long we keep it and how to use your rights. It is a prototype text and has not been reviewed by a lawyer."
        meta={
          <span className="rounded-full border border-rule bg-paper px-2.5 py-1 text-xs font-semibold text-steel">
            Version {NOTICE_VERSION}
          </span>
        }
      />

      <div className="mt-6 flex flex-col gap-5">
        <Panel title="What we collect">
          <p>
            Your name, email and password (stored only as a salted hash); the bids and maximum bids
            you place; your watchlist; sign-in sessions (with the IP address and browser your
            sign-in came from); and security events. We don't ask for phone, Aadhaar, PAN or payment
            details.
          </p>
        </Panel>
        <Panel title="Why we use it">
          <ul className="flex list-disc flex-col gap-1 pl-5">
            {NOTICE_PURPOSES.map((p) => (
              <li key={p.title}>
                <span className="font-semibold text-asphalt">{p.title}.</span> {p.body}
              </li>
            ))}
          </ul>
          <p className="mt-2">We don't sell your data, show ads or send marketing.</p>
        </Panel>
        <Panel title="How long we keep it">
          <ul className="flex flex-col gap-1">
            {NOTICE_RETENTION.map((r) => (
              <li key={r.what}>
                <span className="font-semibold text-asphalt">{r.what}:</span> {r.howLong}
              </li>
            ))}
          </ul>
        </Panel>
        <Panel title="Your rights and choices">
          <p>
            From{" "}
            <Link to="/account" className="font-semibold text-asphalt underline underline-offset-4">
              Account & privacy
            </Link>{" "}
            you can see your details, download a copy of your data and delete your account. Deleting
            your account is also how you withdraw your consent; it does not affect what was done
            before. Bid records of auctions you took part in are kept in pseudonymous form, as
            explained there. For corrections or any other request or grievance, contact the operator
            of this deployment. If you're not satisfied with the answer, you may complain to the
            Data Protection Board of India.
          </p>
        </Panel>
        <Panel title="Who processes it">
          <p>
            The service runs on Cloudflare (hosting, database, file storage and bot checks with
            Turnstile). Data may be processed outside India by that provider.
          </p>
        </Panel>
      </div>
    </section>
  );
}
