/**
 * NetPulse cloud — API validation schemas (zod) and typed responses.
 * The shape contract with the desktop client; consistent error envelope:
 *   { error: { code, message } }  with 4xx/5xx statuses.
 */
import { z } from 'zod';

export const EmailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));

export const PasswordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(200)
  .refine((p) => /[a-z]/.test(p) && /[A-Z]/.test(p) && /[0-9]/.test(p), {
    message: 'Password needs upper case, lower case and a digit',
  });

export const DeviceSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    os: z.string().trim().max(60).optional(),
    appVersion: z.string().trim().max(40).optional(),
  })
  .optional();

export const RegisterSchema = z.object({ email: EmailSchema, password: PasswordSchema, device: DeviceSchema.optional() });

export const LoginSchema = z.object({ email: EmailSchema, password: z.string().min(1).max(200), device: DeviceSchema.optional() });

export const SessionInfoSchema = z.object({
  id: z.string(),
  deviceName: z.string().nullable(),
  os: z.string().nullable(),
  appVersion: z.string().nullable(),
  createdAt: z.number(),
  lastSeenAt: z.number(),
  expiresAt: z.number(),
  current: z.boolean(),
});

export const UserSchema = z.object({
  id: z.string(),
  email: z.string(),
  createdAt: z.number(),
  lastLoginAt: z.number().nullable(),
});

export const AuthResponseSchema = z.object({
  user: UserSchema,
  accessToken: z.string(),
  refreshToken: z.string(),
  session: SessionInfoSchema,
});

export const ProfileEnvelopeSchema = z.object({
  id: z.string(),
  name: z.string(),
  protocol: z.string(),
  endpoint: z.string().nullable(),
  config: z.string(),
  configVersion: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const UpsertProfileSchema = z.object({
  id: z.string().min(1).max(80),
  name: z.string().trim().min(1).max(120),
  protocol: z.string().trim().min(1).max(40),
  endpoint: z.string().trim().max(300).nullable().optional(),
  config: z.string().max(20_000).default('{}'),
  configVersion: z.number().int().min(1).default(1),
  deleted: z.boolean().optional(),
});

export const FavoriteSchema = z.object({ nodeKey: z.string().trim().min(1).max(160), label: z.string().trim().max(120).nullable().optional() });

export const HistoryItemSchema = z.object({
  id: z.string().min(1).max(80),
  kind: z.string().trim().min(1).max(40),
  at: z.number().int(),
  payload: z.string().max(8_000),
});

export const HistoryPushSchema = z.object({ items: z.array(HistoryItemSchema).min(1).max(100) });

export const SettingsSchema = z.object({
  payload: z.string().max(40_000),
  updatedAt: z.number().int(),
});

export const PreferenceSchema = z.object({
  key: z.string().trim().min(1).max(80),
  value: z.string().max(4_000).nullable(),
});

export const ChangePasswordSchema = z.object({ currentPassword: z.string().min(1).max(200), newPassword: PasswordSchema });

export const ForgotSchema = z.object({ email: EmailSchema });

export const ResetSchema = z.object({ token: z.string().min(20).max(200), newPassword: PasswordSchema });

export const RefreshSchema = z.object({ refreshToken: z.string().min(20).max(200) });

export type AuthResponse = z.infer<typeof AuthResponseSchema>;
export type SessionInfo = z.infer<typeof SessionInfoSchema>;
export type UserDto = z.infer<typeof UserSchema>;
export type ProfileEnvelope = z.infer<typeof ProfileEnvelopeSchema>;

export const errorBody = (code: string, message: string): { error: { code: string; message: string } } => ({
  error: { code, message },
});
