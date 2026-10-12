import { z } from "zod";

export const Role = z.enum(["USER", "ADMIN"]);
export type Role = z.infer<typeof Role>;

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;

export const Email = z
  .email()
  .max(254)
  .transform((e) => e.trim().toLowerCase());

export const SignInInput = z.object({
  email: Email,
  password: z.string().min(1, "Enter your password").max(PASSWORD_MAX),
});
export type SignInInput = z.input<typeof SignInInput>;

export const SignUpInput = z.object({
  name: z.string().trim().min(2, "Enter your name").max(80),
  email: Email,
  password: z
    .string()
    .min(PASSWORD_MIN, `Use at least ${PASSWORD_MIN} characters`)
    .max(PASSWORD_MAX, `Use at most ${PASSWORD_MAX} characters`),
});
export type SignUpInput = z.input<typeof SignUpInput>;

export const Me = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  role: Role,
});
export type Me = z.infer<typeof Me>;

export const PublicConfig = z.object({
  environment: z.string(),
  turnstileSiteKey: z.string().nullable(),
  /** When true, the UI shows the public reviewer demo accounts. */
  demoMode: z.boolean(),
});
export type PublicConfig = z.infer<typeof PublicConfig>;
