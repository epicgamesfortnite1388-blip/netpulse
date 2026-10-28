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
  role: z.literal('admin').or(z.literal('normal')),
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

export const CreateAdminAccountSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  password: PasswordSchema,
});

export const AdminPlanPatchSchema = z.object({
  code: z.string().trim().min(1).max(40).optional(),
  name: z.string().trim().min(1).max(120).optional(),
  defaultProfiles: z.string().max(60_000).optional(),
  defaultNodes: z.string().max(60_000).optional(),
  defaultScanProfile: z.string().trim().min(1).max(40).optional(),
  preferredProxyEngine: z.string().trim().min(1).max(40).optional(),
}).refine((v) => Object.keys(v).length > 0, { message: 'At least one updatable field must be supplied' });

export const PlanSchema = z.object({
  id: z.string(),
  code: z.string().min(1).max(40),
  name: z.string().min(1).max(120),
  defaultProfiles: z.string(),
  defaultNodes: z.string(),
  defaultScanProfile: z.string().min(1).max(40),
  preferredProxyEngine: z.string().min(1).max(40),
  updatedAt: z.number().int(),
});

export const AdminAccountSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: z.literal('admin').or(z.literal('normal')),
  createdAt: z.number().int(),
  lastLoginAt: z.number().nullable(),
  disabled: z.boolean(),
});

/**
 * E2E encrypted profile backup. `ciphertext` is an opaque blob the Worker
 * cannot read (client-side AES-GCM over the full profile config); the schema
 * accepts no plaintext config field by design, so a hostile client cannot
 * stash unencrypted data here either.
 */
export const VaultPutSchema = z.object({
  profileId: z.string().trim().min(1).max(80),
  ciphertext: z.string().min(16).max(96_000).regex(/^[A-Za-z0-9+/=.\r\n]+$/, 'must be base64'),
  updatedAt: z.number().int(),
});

export const VaultDeleteSchema = z.object({ profileId: z.string().trim().min(1).max(80) });

export type AuthResponse = z.infer<typeof AuthResponseSchema>;
export type SessionInfo = z.infer<typeof SessionInfoSchema>;
export type UserDto = z.infer<typeof UserSchema>;
export type ProfileEnvelope = z.infer<typeof ProfileEnvelopeSchema>;
export type VaultPut = z.infer<typeof VaultPutSchema>;
export type CreateAdminAccount = z.infer<typeof CreateAdminAccountSchema>;
export type Plan = z.infer<typeof PlanSchema>;
export type AdminUser = z.infer<typeof AdminAccountSchema>;

export const errorBody = (code: string, message: string): { error: { code: string; message: string } } => ({
  error: { code, message },
});

/** Request: provision client configs for every VPN method the active plan
 *  entitles. Body may name a specific subscription id; otherwise the most
 *  recent active entitlement is used. */
export const ProvisionRequestSchema = z.object({
  subscriptionId: z.string().trim().min(1).max(80).optional(),
});

export const ProvisionProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  protocol: z.string(),
  endpoint: z.string().nullable(),
  config: z.string(),
});

export const ProvisionResponseSchema = z.object({
  ok: z.boolean().default(true),
  provisioned: z.array(ProvisionProfileSchema),
  skipped: z.array(z.object({ protocol: z.string(), reason: z.string() })),
  errors: z.array(z.object({ protocol: z.string(), reason: z.string() })),
});

export type ProvisionRequest = z.infer<typeof ProvisionRequestSchema>;
export type ProvisionResponse = z.infer<typeof ProvisionResponseSchema>;
