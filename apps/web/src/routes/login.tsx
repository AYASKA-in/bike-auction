import { SignInInput } from "@bike/contracts";
import { zodResolver } from "@hookform/resolvers/zod";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Turnstile } from "@/components/turnstile";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { DEMO_ACCOUNTS } from "@/lib/demo";
import { authErrorMessage, useConfig, useSignIn } from "@/lib/session";
import { AuthFrame } from "./auth-form";

export function LoginPage() {
  const { redirect } = useSearch({ from: "/login" });
  const navigate = useNavigate();
  const config = useConfig();
  const signIn = useSignIn();
  const [captcha, setCaptcha] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const form = useForm<SignInInput>({
    resolver: zodResolver(SignInInput),
    defaultValues: { email: "", password: "" },
  });
  const siteKey = config.data?.turnstileSiteKey ?? null;
  const needsCaptcha = siteKey !== null;

  const onSubmit = form.handleSubmit((input) =>
    signIn.mutate(
      { input, captcha },
      {
        onSuccess: () => void navigate({ to: redirect ?? "/" }),
        onError: () => setResetKey((k) => k + 1), // tokens are single-use
      },
    ),
  );

  return (
    <AuthFrame
      title="Sign in"
      intro="Sign in to place bids and follow auctions you're in."
      aside={
        config.data?.demoMode ? (
          <DemoAccounts onPick={(a) => form.reset({ email: a.email, password: a.password })} />
        ) : null
      }
    >
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
        {signIn.isError && <Alert>{authErrorMessage(signIn.error)}</Alert>}
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
          autoComplete="current-password"
          {...form.register("password")}
          error={form.formState.errors.password?.message}
        />
        {needsCaptcha && <Turnstile siteKey={siteKey} onToken={setCaptcha} resetKey={resetKey} />}
        <Button type="submit" size="lg" disabled={signIn.isPending || (needsCaptcha && !captcha)}>
          {signIn.isPending ? "Signing in…" : "Sign in"}
        </Button>
        <p className="text-sm text-steel">
          New here?{" "}
          <Link
            to="/register"
            search={redirect ? { redirect } : {}}
            className="font-semibold text-asphalt underline underline-offset-4"
          >
            Create an account
          </Link>
        </p>
      </form>
    </AuthFrame>
  );
}

function DemoAccounts({ onPick }: { onPick: (a: (typeof DEMO_ACCOUNTS)[number]) => void }) {
  return (
    <div className="rounded-xl border border-rule bg-paper p-6">
      <h2 className="text-lg font-bold">Reviewing the demo?</h2>
      <p className="mt-2 text-sm text-steel">
        Pick an account to fill in the form. Open Buyer A and Buyer B in two browser windows to bid
        against each other.
      </p>
      <ul className="mt-5 flex flex-col gap-2">
        {DEMO_ACCOUNTS.map((a) => (
          <li key={a.email}>
            <button
              type="button"
              onClick={() => onPick(a)}
              className="flex w-full items-center justify-between gap-4 rounded-md border border-rule bg-white px-4 py-3 text-left hover:border-asphalt"
            >
              <span className="font-semibold">{a.label}</span>
              <span className="truncate text-sm text-steel">{a.email}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
