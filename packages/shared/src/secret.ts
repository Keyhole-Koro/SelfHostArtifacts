import { z } from "zod";

/**
 * Secret handoff: the recipient's browser makes an ECDH P-256 key pair and keeps the private key;
 * the sender encrypts to its public key on their own computer; the Worker only relays the public
 * key and the ciphertext. See docs/design.md, "秘密の受け渡し".
 *
 * Envelope v1: the sender makes a one-time P-256 key pair, derives 256 bits with ECDH, runs
 * HKDF-SHA256 (salt = sender public key || recipient public key, info = SECRET_INFO "\0" id) to an
 * AES-256-GCM key, and encrypts the JSON plaintext with a random 12-byte IV and SECRET_INFO "\0" id
 * as additional data, so a ciphertext cannot be moved to another request.
 */
export const SECRET_INFO = "artifact-secret v1";

export const SECRET_DEFAULT_HOURS = 72;
/** Safari deletes a site's storage (and so the recipient's key) after 7 days without a visit. */
export const SECRET_MAX_HOURS = 168;
export const MAX_SECRET_LABEL = 100;
export const MAX_SECRET_ITEMS = 50;
export const MAX_SECRET_NAME = 100;
export const MAX_SECRET_VALUE = 4096;
export const MAX_SECRET_PLAINTEXT_BYTES = 16 * 1024;

const B64URL = /^[A-Za-z0-9_-]+$/;
/** Uncompressed P-256 point (65 bytes) in base64url. */
export const P256_PUBLIC_KEY = /^[A-Za-z0-9_-]{87}$/;

export const secretCreateSchema = z.object({
  label: z.string().trim().min(1, "label is empty").max(MAX_SECRET_LABEL, `label is longer than ${MAX_SECRET_LABEL} characters`),
  expires_in_hours: z.number().int().min(1).max(SECRET_MAX_HOURS, `a request lasts at most ${SECRET_MAX_HOURS} hours`).optional(),
});
export type SecretCreate = z.infer<typeof secretCreateSchema>;

export const secretEnvelopeSchema = z.object({
  v: z.literal(1),
  epk: z.string().regex(P256_PUBLIC_KEY, "epk must be a P-256 public key"),
  iv: z.string().regex(/^[A-Za-z0-9_-]{16}$/, "iv must be 12 bytes"),
  // AES-GCM adds a 16-byte tag; base64url grows by 4/3.
  ct: z.string().regex(B64URL).max(Math.ceil(((MAX_SECRET_PLAINTEXT_BYTES + 16) * 4) / 3), "the secret is too large"),
});
export type SecretEnvelope = z.infer<typeof secretEnvelopeSchema>;

export const secretSealSchema = z.object({ envelope: secretEnvelopeSchema });

export const secretClaimSchema = z.object({ public_key: z.string().regex(P256_PUBLIC_KEY, "public_key must be a P-256 public key") });

export interface SecretItem {
  name: string;
  value: string;
}

/** What is encrypted. */
export interface SecretPlaintext {
  items: SecretItem[];
}

/**
 * waiting: nobody opened the link yet. claimed: a browser opened it and sent its public key.
 * sealed: the sender put the ciphertext. received: the recipient deleted it after reading.
 * deleted: the owner or an agent deleted it. expired: the time ran out.
 */
export type SecretStatus = "waiting" | "claimed" | "sealed" | "received" | "deleted" | "expired";

export interface SecretCreateResponse {
  id: string;
  /** The link for the recipient. It is shown only here: the server keeps a hash of its token. */
  url: string;
  label: string;
  expires_at: string;
}

export interface SecretSummary {
  id: string;
  label: string;
  status: SecretStatus;
  created_at: string;
  expires_at: string;
  claimed_at: string | null;
  claim_ip: string | null;
  claim_user_agent: string | null;
  /** The recipient's public key, once claimed. Compute the fingerprint locally; do not trust a server-made one. */
  public_key: string | null;
  sealed_at: string | null;
  opened_at: string | null;
  finished_at: string | null;
}

export interface SecretListResponse {
  secrets: SecretSummary[];
}

/**
 * Browser code shared by the recipient's page (/assets/secret.js) and the CLI tests, so the tests
 * decrypt with exactly what the browser runs. Defines `secretCrypto` with generate(),
 * fingerprint(), decrypt(). Plain JS, Web Crypto only.
 */
export const SECRET_CRYPTO_JS = `
const secretCrypto = (() => {
  const INFO = ${JSON.stringify(SECRET_INFO)};
  const enc = new TextEncoder();
  const b64 = {
    toBytes(s) {
      const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
      return Uint8Array.from(b, (c) => c.charCodeAt(0));
    },
    from(buf) {
      let s = "";
      for (const x of new Uint8Array(buf)) s += String.fromCharCode(x);
      return btoa(s).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
    },
  };
  const P256 = { name: "ECDH", namedCurve: "P-256" };

  /** A key pair whose private key cannot be exported. The public key is always exportable. */
  async function generate() {
    const pair = await crypto.subtle.generateKey(P256, false, ["deriveBits"]);
    const raw = await crypto.subtle.exportKey("raw", pair.publicKey);
    return { privateKey: pair.privateKey, publicKey: b64.from(raw) };
  }

  /** 12 digits from SHA-256 of the raw public key, e.g. "0412 7781 3390". */
  async function fingerprint(publicKey) {
    const d = new Uint8Array(await crypto.subtle.digest("SHA-256", b64.toBytes(publicKey)));
    let n = 0n;
    for (let i = 0; i < 8; i++) n = (n << 8n) | BigInt(d[i]);
    const s = (n % 1000000000000n).toString().padStart(12, "0");
    return s.slice(0, 4) + " " + s.slice(4, 8) + " " + s.slice(8);
  }

  async function decrypt(privateKey, publicKey, id, envelope) {
    if (!envelope || envelope.v !== 1) throw new Error("Unsupported envelope");
    const epk = b64.toBytes(envelope.epk);
    const rpk = b64.toBytes(publicKey);
    const sender = await crypto.subtle.importKey("raw", epk, P256, false, []);
    const bits = await crypto.subtle.deriveBits({ name: "ECDH", public: sender }, privateKey, 256);
    const ikm = await crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
    const salt = new Uint8Array(epk.length + rpk.length);
    salt.set(epk);
    salt.set(rpk, epk.length);
    const context = enc.encode(INFO + "\\0" + id);
    const key = await crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt, info: context },
      ikm,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"],
    );
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64.toBytes(envelope.iv), additionalData: context }, key, b64.toBytes(envelope.ct));
    return JSON.parse(new TextDecoder().decode(plain));
  }

  return { b64, generate, fingerprint, decrypt };
})();
`;
