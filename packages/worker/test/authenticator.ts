import { base64url, fromBase64url, utf8 } from "../src/lib/encoding.ts";

/**
 * A software WebAuthn authenticator for tests: ES256 key, "none" attestation. Its output goes
 * through the real verification in @simplewebauthn/server.
 */

type Cbor = number | string | Uint8Array | Cbor[] | Map<Cbor, Cbor> | { [key: string]: Cbor };

function head(major: number, n: number): number[] {
  if (n < 24) return [(major << 5) | n];
  if (n < 256) return [(major << 5) | 24, n];
  if (n < 65536) return [(major << 5) | 25, n >> 8, n & 255];
  return [(major << 5) | 26, (n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function cbor(value: Cbor): number[] {
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === "string") {
    const bytes = utf8(value);
    return [...head(3, bytes.length), ...bytes];
  }
  if (value instanceof Uint8Array) return [...head(2, value.length), ...value];
  if (Array.isArray(value)) return [...head(4, value.length), ...value.flatMap(cbor)];
  const entries = value instanceof Map ? [...value.entries()] : Object.entries(value);
  return [...head(5, entries.length), ...entries.flatMap(([k, v]) => [...cbor(k), ...cbor(v)])];
}

function concat(...parts: (Uint8Array | number[])[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

async function sha256(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

/** ECDSA signature from WebCrypto (r || s) to the DER form WebAuthn uses. */
function toDer(raw: Uint8Array): Uint8Array<ArrayBuffer> {
  const int = (bytes: Uint8Array) => {
    let i = 0;
    while (i < bytes.length - 1 && bytes[i] === 0) i++;
    let v = bytes.slice(i);
    if (v[0]! & 0x80) v = concat([0], v);
    return concat([0x02, v.length], v);
  };
  const body = concat(int(raw.slice(0, 32)), int(raw.slice(32)));
  return concat([0x30, body.length], body);
}

export interface SoftPasskey {
  id: string;
  /** Answers navigator.credentials.create() options with a registration response. */
  register(options: any, origin: string): Promise<any>;
  /** Answers navigator.credentials.get() options with an authentication response. */
  authenticate(options: any, origin: string): Promise<any>;
}

export async function softPasskey(): Promise<SoftPasskey> {
  const keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", keys.publicKey)) as JsonWebKey;
  const credentialId = crypto.getRandomValues(new Uint8Array(16));
  const id = base64url(credentialId);
  let userHandle = "";
  let counter = 0;

  const coseKey = new Map<Cbor, Cbor>([
    [1, 2], // kty: EC2
    [3, -7], // alg: ES256
    [-1, 1], // crv: P-256
    [-2, fromBase64url(jwk.x!)],
    [-3, fromBase64url(jwk.y!)],
  ]);

  const counterBytes = (n: number) => [(n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];

  return {
    id,
    async register(options, origin) {
      userHandle = options.user.id;
      const clientData = utf8(JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin, crossOrigin: false }));
      const authData = concat(
        await sha256(utf8(options.rp.id)),
        [0x45], // user present, user verified, attested credential data
        counterBytes(counter),
        new Uint8Array(16), // aaguid
        [credentialId.length >> 8, credentialId.length & 255],
        credentialId,
        cbor(coseKey),
      );
      const attestationObject = new Uint8Array(cbor({ fmt: "none", attStmt: {}, authData }));
      return {
        id,
        rawId: id,
        type: "public-key",
        clientExtensionResults: {},
        response: { clientDataJSON: base64url(clientData), attestationObject: base64url(attestationObject), transports: ["internal"] },
      };
    },
    async authenticate(options, origin) {
      counter += 1;
      const clientData = utf8(JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin, crossOrigin: false }));
      const authData = concat(await sha256(utf8(options.rpId)), [0x05], counterBytes(counter));
      const signed = concat(authData, await sha256(clientData));
      const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, signed));
      return {
        id,
        rawId: id,
        type: "public-key",
        clientExtensionResults: {},
        response: {
          clientDataJSON: base64url(clientData),
          authenticatorData: base64url(authData),
          signature: base64url(toDer(raw)),
          userHandle,
        },
      };
    },
  };
}
