import { Me, PublicConfig, type SignInInput, type SignUpInput } from "@bike/contracts";
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiGet, apiPost } from "./api";

export const meQuery = queryOptions({
  queryKey: ["me"],
  queryFn: async ({ signal }) => {
    try {
      return await apiGet("/me", (x) => Me.parse(x), signal);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return null; // anonymous is a valid state
      throw err;
    }
  },
  staleTime: 60_000,
});

export const configQuery = queryOptions({
  queryKey: ["config"],
  queryFn: ({ signal }) => apiGet("/config", (x) => PublicConfig.parse(x), signal),
  staleTime: Infinity,
});

export const useMe = () => useQuery(meQuery);
export const useConfig = () => useQuery(configQuery);

const ignore = () => null;

function captchaHeaders(token: string | null): Record<string, string> {
  return token ? { "x-captcha-response": token } : {};
}

export function useSignIn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ input, captcha }: { input: SignInInput; captcha: string | null }) =>
      apiPost("/auth/sign-in/email", input, ignore, captchaHeaders(captcha)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }),
  });
}

export function useSignUp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ input, captcha }: { input: SignUpInput; captcha: string | null }) =>
      apiPost("/auth/sign-up/email", input, ignore, captchaHeaders(captcha)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }),
  });
}

export function useSignOut() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiPost("/auth/sign-out", {}, ignore),
    onSettled: () => {
      qc.setQueryData(meQuery.queryKey, null);
      qc.removeQueries({ queryKey: ["admin"] });
    },
  });
}

/** Maps API error codes to user-facing copy. */
export function authErrorMessage(err: unknown): string {
  if (!(err instanceof ApiError)) return "Something went wrong. Try again.";
  switch (err.code) {
    case "INVALID_CREDENTIALS":
      return "Email or password is incorrect.";
    case "ACCOUNT_EXISTS":
      return "An account with this email already exists. Sign in instead.";
    case "WEAK_PASSWORD":
      return err.detail ?? "Choose a stronger password.";
    case "CAPTCHA_FAILED":
      return "The bot check didn't go through. Complete it again and retry.";
    case "RATE_LIMITED":
      return `Too many attempts. Try again in ${formatWait(err.retryAfterSeconds ?? 60)}.`;
    case "VALIDATION_FAILED":
      return err.detail ?? "Check the highlighted fields.";
    case "NETWORK":
      return "Can't reach the server. Check your connection and try again.";
    default:
      return `Something went wrong on our side${err.requestId ? ` (reference ${err.requestId})` : ""}. Try again.`;
  }
}

function formatWait(seconds: number): string {
  return seconds < 90 ? `${seconds} seconds` : `${Math.ceil(seconds / 60)} minutes`;
}
