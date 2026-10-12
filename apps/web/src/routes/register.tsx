import { PASSWORD_MIN, SignUpInput } from "@bike/contracts";
import { zodResolver } from "@hookform/resolvers/zod";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useState } from "react";
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

  const onSubmit = form.handleSubmit((input) =>
    signUp.mutate(
      { input, captcha },
      {
        onSuccess: () => void navigate({ to: redirect ?? "/" }),
        onError: () => setResetKey((k) => k + 1),
      },
    ),
  );

  return (
    <AuthFrame
      title="Create your account"
      intro="You need an account to bid. We only ask for your name and email."
      aside={
        <div className="rounded-xl border border-rule bg-paper p-6 text-sm text-steel">
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
