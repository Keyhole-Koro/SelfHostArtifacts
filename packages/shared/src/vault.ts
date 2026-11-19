import { z } from "zod";
import { P256_PUBLIC_KEY } from "./secret.ts";

/**
 * The vault: secrets kept so that only the owner's and the devices' keys can open them. The Worker
 * stores ciphertexts, public keys and wrapped keys; it never holds a private key or a plaintext.
 * See docs/design.md, "金庫".
 *
 * Keys, from the outside in:
 *   recovery key (and later a passkey)  →  owner key
 *   owner key, each device's key        →  collection key (one per collection, replaced when a device is revoked)
 *   collection key                      →  data key (one per secret version)
 *   data key                            →  the value
 *
 * Wrapping to a public key uses envelope v1 from the secret handoff (one-time ECDH P-256 → HKDF-SHA256
 * → AES-256-GCM); the HKDF info and the additional data are VAULT_INFO "\0" <context>, where the
 * context names what is wrapped (see vaultContext), so a wrapped key cannot be moved to another place.
 * Symmetric envelopes (the value under its data key, the owner key under the recovery key) are
 * AES-256-GCM with the same additional data.
 */
export const VAULT_INFO = "artifact-vault v1";

/** Collection and secret names: like environment variable or file names, 1 to 100 characters. */
export const VAULT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
export const MAX_VAULT_NAME = 100;
export const MAX_VAULT_DESCRIPTION = 200;
export const MAX_VAULT_USED_BY = 500;
/** A value is at most 64 KiB, the same as Secret Manager. */
export const MAX_VAULT_VALUE_BYTES = 64 * 1024;
/** How many bytes of generated secret `vault put --generate` makes by default. */
export const VAULT_GENERATE_BYTES = 32;

const B64URL = /^[A-Za-z0-9_-]+$/;
const IV = /^[A-Za-z0-9_-]{16}$/;
/** AES-GCM adds a 16-byte tag; base64url grows by 4/3. */
const ctMax = (plaintextBytes: number) => Math.ceil(((plaintextBytes + 16) * 4) / 3);
/** A wrapped key is a JWK of a P-256 private key (about 200 bytes) or a 32-byte data key. */
const MAX_WRAPPED_KEY_BYTES = 512;

/** Something encrypted to a P-256 public key (envelope v1). */
export const vaultEnvelopeSchema = z.object({
  v: z.literal(1),
  epk: z.string().regex(P256_PUBLIC_KEY, "epk must be a P-256 public key"),
  iv: z.string().regex(IV, "iv must be 12 bytes"),
  ct: z.string().regex(B64URL).max(ctMax(MAX_WRAPPED_KEY_BYTES), "the wrapped key is too large"),
});
export type VaultEnvelope = z.infer<typeof vaultEnvelopeSchema>;

/** Something encrypted with a symmetric key: the value under its data key, or the owner key under the recovery key. */
export const vaultSealedSchema = z.object({
  v: z.literal(1),
  iv: z.string().regex(IV, "iv must be 12 bytes"),
  ct: z.string().regex(B64URL).max(ctMax(MAX_VAULT_VALUE_BYTES), `a value is at most ${MAX_VAULT_VALUE_BYTES} bytes`),
});
export type VaultSealed = z.infer<typeof vaultSealedSchema>;

const nameSchema = (what: string) => z.string().regex(VAULT_NAME, `${what} names use letters, digits, - _ . and are at most ${MAX_VAULT_NAME} characters`);
export const vaultCollectionName = nameSchema("Collection");
export const vaultSecretName = nameSchema("Secret");

/**
 * The HKDF info / additional data for each kind of wrap. Every part that identifies the place is
 * included, so moving a ciphertext to another collection, secret, version or member fails to open.
 */
export const vaultContext = {
  /** A collection's private key, wrapped for one member. */
  collectionKey: (collection: string, keyVersion: number, memberId: string) => `${VAULT_INFO}\0collection-key\0${collection}\0${keyVersion}\0${memberId}`,
  /** A secret version's data key, wrapped for the collection key. */
  dataKey: (collection: string, secret: string, version: number) => `${VAULT_INFO}\0data-key\0${collection}\0${secret}\0${version}`,
  /** A secret version's value, under its data key. */
  value: (collection: string, secret: string, version: number) => `${VAULT_INFO}\0value\0${collection}\0${secret}\0${version}`,
  /** The owner's private key, under the recovery key. */
  ownerKey: (wrappedBy: string) => `${VAULT_INFO}\0owner-key\0${wrappedBy}`,
};

/** `recovery`, or `passkey:<credential id>` once passkeys can open the owner key. */
export const vaultWrappedBySchema = z.string().regex(/^(recovery|passkey:[A-Za-z0-9_-]{1,200})$/);

// ---- API bodies ----

/** PUT /api/v1/vault/members/me — this device's encryption public key. */
export const vaultMemberRegisterSchema = z.object({
  public_key: z.string().regex(P256_PUBLIC_KEY, "public_key must be a P-256 public key"),
});

/** PUT /api/v1/vault/owner — the owner key, made once by `artifact vault init`. */
export const vaultOwnerSetSchema = z.object({
  public_key: z.string().regex(P256_PUBLIC_KEY, "public_key must be a P-256 public key"),
  wraps: z.array(z.object({ wrapped_by: vaultWrappedBySchema, envelope: vaultSealedSchema })).min(1).max(10),
});

export const vaultGrantInputSchema = z.object({
  member_id: z.string().min(1).max(64),
  envelope: vaultEnvelopeSchema,
});
export type VaultGrantInput = z.infer<typeof vaultGrantInputSchema>;

/** POST /api/v1/vault/collections */
export const vaultCollectionCreateSchema = z.object({
  name: vaultCollectionName,
  public_key: z.string().regex(P256_PUBLIC_KEY, "public_key must be a P-256 public key"),
  /** The collection key wrapped for the creating device and for the owner, at least. */
  grants: z.array(vaultGrantInputSchema).min(1).max(100),
});

/** POST /api/v1/vault/collections/:name/grants */
export const vaultGrantCreateSchema = vaultGrantInputSchema.extend({
  key_version: z.number().int().min(1),
});

/**
 * POST /api/v1/vault/collections/:name/rotate — a new collection key after a device was revoked:
 * the new key wrapped for every remaining member, and every live version's data key wrapped again.
 */
export const vaultRotateSchema = z.object({
  key_version: z.number().int().min(2),
  public_key: z.string().regex(P256_PUBLIC_KEY, "public_key must be a P-256 public key"),
  grants: z.array(vaultGrantInputSchema).min(1).max(100),
  versions: z.array(z.object({ secret: vaultSecretName, version: z.number().int().min(1), wrapped_dek: vaultEnvelopeSchema })).max(5000),
});

/** PUT /api/v1/vault/collections/:name/secrets/:secret — a new version of a value. */
export const vaultSecretPutSchema = z.object({
  description: z.string().trim().max(MAX_VAULT_DESCRIPTION).optional(),
  used_by: z.string().trim().max(MAX_VAULT_USED_BY).optional(),
  /** The version this value was encrypted for (it is in the additional data): the current one plus one. */
  version: z.number().int().min(1),
  key_version: z.number().int().min(1),
  wrapped_dek: vaultEnvelopeSchema,
  ciphertext: vaultSealedSchema,
});

/** PATCH /api/v1/vault/collections/:name/secrets/:secret — the ledger, without a new version. */
export const vaultSecretPatchSchema = z.object({
  description: z.string().trim().max(MAX_VAULT_DESCRIPTION).nullable().optional(),
  used_by: z.string().trim().max(MAX_VAULT_USED_BY).nullable().optional(),
});

// ---- API responses ----

export type VaultMemberKind = "device" | "owner";

export interface VaultMember {
  id: string;
  kind: VaultMemberKind;
  device_id: string | null;
  /** The device's name, for people; the fingerprint is computed from public_key on each side. */
  device_name: string | null;
  public_key: string;
  created_at: string;
  revoked_at: string | null;
}

export interface VaultCollectionSummary {
  name: string;
  key_version: number;
  members: number;
  secrets: number;
  /** True when the calling device holds a grant for the current key. */
  readable: boolean;
  created_at: string;
  updated_at: string;
}

export interface VaultCollectionDetail extends VaultCollectionSummary {
  public_key: string;
  /** Members with a grant for the current key. */
  grants: VaultMember[];
  /** The collection key wrapped for the calling device, when it has one. */
  my_grant: VaultEnvelope | null;
}

export interface VaultSecretSummary {
  name: string;
  description: string | null;
  used_by: string | null;
  current_version: number;
  /** Versions that still hold a value. */
  live_versions: number;
  created_at: string;
  updated_at: string;
}

export interface VaultVersionInfo {
  version: number;
  key_version: number;
  created_by: string;
  created_at: string;
  destroyed_at: string | null;
}

/** What a device needs to open one version: the ciphertext, the wrapped data key and its own grant. */
export interface VaultVersionResponse {
  collection: string;
  secret: string;
  version: number;
  key_version: number;
  wrapped_dek: VaultEnvelope;
  ciphertext: VaultSealed;
  /** The collection key (of `key_version`) wrapped for the calling device. */
  grant: VaultEnvelope;
  /** The collection public key of that key version, needed to unwrap the grant. */
  collection_public_key: string;
}

export interface VaultOwner {
  member_id: string;
  public_key: string;
  wraps: { wrapped_by: string; envelope: VaultSealed; created_at: string }[];
}

/** Everything a rotation needs: who keeps a grant, and every live version to re-wrap. */
export interface VaultRotationPlan {
  key_version: number;
  public_key: string;
  members: VaultMember[];
  versions: { secret: string; version: number; key_version: number; wrapped_dek: VaultEnvelope }[];
}
