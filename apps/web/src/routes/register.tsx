import {
  CURRENT_SIGN_UP_CONSENT,
  PASSWORD_MIN,
  PRIVACY_NOTICE_VERSION,
  SignUpInput,
} from "@bike/contracts";
import { zodResolver } from "@hookform/resolvers/zod";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useId, useState } from "react";
import { useForm } from "react-hook-form";
import { Turnstile } from "@/components/turnstile";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { ApiError } from "@/lib/api";
import { authErrorMessage, useConfig, useSignUp } from "@/lib/session";
import { AuthFrame } from "./auth-form";

export function RegisterPage() {
  const { redirect } = useSearch({ from: "/register" });
  const navigate = useNavigate();
  const config = useConfig();
  const signUp = useSignUp();
  const [captcha, setCaptcha] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const form = useForm<SignUpInput>({
    resolver: zodResolver(SignUpInput),
    defaultValues: { name: "", email: "", password: "" },
  });
  const siteKey = config.data?.turnstileSiteKey ?? null;
  const needsCaptcha = siteKey !== null;
  const exists = signUp.error instanceof ApiError && signUp.error.code === "ACCOUNT_EXISTS";

  const consentId = useId();
  const [consent, setConsent] = useState(false); // never pre-ticked
  const [consentError, setConsentError] = useState(false);

  const onSubmit = form.handleSubmit((fields) => {
    if (!consent) {
      setConsentError(true);
      return;
    }
    // Consent (with the notice version) is recorded server-side; sign-up is refused without it.
    const input = { ...fields, consent: CURRENT_SIGN_UP_CONSENT };
    signUp.mutate(
      { input, captcha },
      {
        onSuccess: () => void navigate({ to: redirect ?? "/" }),
        onError: () => setResetKey((k) => k + 1),
      },
    );
  });

  return (
    <AuthFrame
      title="Create your account"
      intro="You need an account to bid. We only ask for your name and email."
      aside={
        <div className="rounded-xl border border-dashed border-control/60 bg-paper/60 p-5 text-sm text-steel sm:p-6">
          <h2 className="text-lg font-bold text-asphalt">What we keep</h2>
          <p className="mt-2">
            Your name, email and the bids you place. Other bidders see a code like "Bidder K7Q2",
            never your name, and the code changes from one auction to the next.
          </p>
        </div>
      }
    >
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
        {signUp.isError && (
          <Alert>
            {authErrorMessage(signUp.error)}{" "}
            {exists && (
              <Link to="/login" className="font-semibold underline underline-offset-4">
                Go to sign in
              </Link>
            )}
          </Alert>
        )}
        <Field
          label="Full name"
          autoComplete="name"
          {...form.register("name")}
          error={form.formState.errors.name?.message}
        />
        <Field
          label="Email"
          type="email"
          autoComplete="email"
          {...form.register("email")}
          error={form.formState.errors.email?.message}
        />
        <Field
          label="Password"
          type="password"
          autoComplete="new-password"
          hint={`At least ${PASSWORD_MIN} characters. A short phrase is easier to remember than symbols.`}
          {...form.register("password")}
          error={form.formState.errors.password?.message}
        />
        <div className="flex flex-col gap-1.5">
          <div className="flex items-start gap-3">
            <input
              id={consentId}
              type="checkbox"
              checked={consent}
              onChange={(e) => {
                setConsent(e.target.checked);
                if (e.target.checked) setConsentError(false);
              }}
              aria-invalid={consentError || undefined}
              aria-describedby={`${consentId}-notice${consentError ? ` ${consentId}-err` : ""}`}
              className="mt-0.5 size-5 shrink-0 accent-hivis"
              data-testid="consent"
            />
            <label htmlFor={consentId} className="text-sm font-semibold">
              I agree to the Privacy Notice and Terms
            </label>
          </div>
          <p id={`${consentId}-notice`} className="pl-8 text-sm text-steel">
            We use your name, email and bids only to run your account and the auctions you join, and
            security logs to keep the service safe.{" "}
            <Link
              to="/privacy"
              target="_blank"
              className="font-semibold text-asphalt underline underline-offset-4"
            >
              Read the Privacy Notice
            </Link>{" "}
            (version {PRIVACY_NOTICE_VERSION}). You can download your data or delete your account
            any time from Account &amp; privacy.
          </p>
          {consentError && (
            <p
              id={`${consentId}-err`}
              className="flex items-start gap-1.5 pl-8 text-sm font-medium text-danger"
            >
              <svg viewBox="0 0 20 20" className="mt-0.5 size-4 shrink-0" aria-hidden="true">
                <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeWidth="2" />
                <path
                  d="M10 6v5M10 13.5v.5"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
              Agree to the Privacy Notice and Terms to create an account.
            </p>
          )}
        </div>
        {needsCaptcha && <Turnstile siteKey={siteKey} onToken={setCaptcha} resetKey={resetKey} />}
        <Button type="submit" size="lg" disabled={signUp.isPending || (needsCaptcha && !captcha)}>
          {signUp.isPending ? "Creating account…" : "Create account"}
        </Button>
        <p className="text-sm text-steel">
          Already registered?{" "}
          <Link to="/login" className="font-semibold text-asphalt underline underline-offset-4">
            Sign in
          </Link>
        </p>
      </form>
    </AuthFrame>
  );
}
