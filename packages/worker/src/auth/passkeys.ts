import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppEnv } from "../app-env.ts";
import { getPasskey, listPasskeys, type PasskeyRow } from "../db/users.ts";
import { base64url, fromBase64url, utf8 } from "../lib/encoding.ts";
import { sign, verify } from "../lib/signed.ts";

/**
 * WebAuthn ceremonies. The challenge lives in a short-lived signed cookie, so nothing is stored
 * until a passkey is verified.
 */

const CHALLENGE_COOKIE = "__Host-artifact_webauthn";
const CHALLENGE_SECONDS = 5 * 60;
const RP_NAME = "Artifacts";

export type Ceremony =
  | { kind: "login"; challenge: string; exp: number }
  /** Registering a passkey for an existing user, or for a new one through an invite. */
  | { kind: "register"; challenge: string; userId: string; name: string; inviteHash?: string; exp: number };

type CeremonyInput = Ceremony extends infer T ? (T extends Ceremony ? Omit<T, "challenge" | "exp"> : never) : never;

async function remember(c: Context<AppEnv>, ceremony: CeremonyInput, challenge: string): Promise<void> {
  const exp = Math.floor(Date.now() / 1000) + CHALLENGE_SECONDS;
  setCookie(c, CHALLENGE_COOKIE, await sign({ ...ceremony, challenge, exp }, c.env.SESSION_SECRET), {
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Strict",
    maxAge: CHALLENGE_SECONDS,
  });
}

/** The pending ceremony, consumed: a challenge can be answered once. */
export async function takeCeremony(c: Context<AppEnv>): Promise<Ceremony | undefined> {
  const cookie = getCookie(c, CHALLENGE_COOKIE);
  deleteCookie(c, CHALLENGE_COOKIE, { path: "/", secure: true });
  return cookie ? verify<Ceremony>(cookie, c.env.SESSION_SECRET) : undefined;
}

export async function registrationOptions(
  c: Context<AppEnv>,
  user: { id: string; name: string; inviteHash?: string },
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const existing = await listPasskeys(c.env.DB, user.id);
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: c.get("config").rpId,
    userName: user.name,
    userDisplayName: user.name,
    userID: utf8(user.id),
    attestationType: "none",
    excludeCredentials: existing.map((p) => ({ id: p.id, transports: p.transports ? (JSON.parse(p.transports) as string[]) : undefined })),
    // Discoverable, so signing in needs no user name.
    authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
  });
  await remember(c, { kind: "register", userId: user.id, name: user.name, inviteHash: user.inviteHash }, options.challenge);
  return options;
}

export interface VerifiedPasskey {
  id: string;
  publicKey: string;
  counter: number;
  transports: string[] | undefined;
}

export async function verifyRegistration(
  c: Context<AppEnv>,
  ceremony: Extract<Ceremony, { kind: "register" }>,
  response: RegistrationResponseJSON,
): Promise<VerifiedPasskey | undefined> {
  const config = c.get("config");
  try {
    const result = await verifyRegistrationResponse({
      response,
      expectedChallenge: ceremony.challenge,
      expectedOrigin: config.origin,
      expectedRPID: config.rpId,
      requireUserVerification: false,
    });
    if (!result.verified) return undefined;
    const { credential } = result.registrationInfo;
    return {
      id: credential.id,
      publicKey: base64url(credential.publicKey),
      counter: credential.counter,
      transports: credential.transports,
    };
  } catch (e) {
    console.warn("passkey.register_failed", String(e));
    return undefined;
  }
}

export async function authenticationOptions(c: Context<AppEnv>): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const options = await generateAuthenticationOptions({ rpID: c.get("config").rpId, userVerification: "preferred" });
  await remember(c, { kind: "login" }, options.challenge);
  return options;
}

/** The passkey that signed the response, with its counter updated; undefined when invalid. */
export async function verifyAuthentication(
  c: Context<AppEnv>,
  ceremony: Extract<Ceremony, { kind: "login" }>,
  response: AuthenticationResponseJSON,
): Promise<PasskeyRow | undefined> {
  const config = c.get("config");
  const passkey = await getPasskey(c.env.DB, response.id);
  if (!passkey) return undefined;
  try {
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: ceremony.challenge,
      expectedOrigin: config.origin,
      expectedRPID: config.rpId,
      credential: {
        id: passkey.id,
        publicKey: fromBase64url(passkey.public_key),
        counter: passkey.counter,
        transports: passkey.transports ? (JSON.parse(passkey.transports) as string[]) : undefined,
      },
      requireUserVerification: false,
    });
    if (!result.verified) return undefined;
    await c.env.DB.prepare("update passkeys set counter = ?, last_used_at = ? where id = ?")
      .bind(result.authenticationInfo.newCounter, new Date().toISOString(), passkey.id)
      .run();
    return passkey;
  } catch (e) {
    console.warn("passkey.login_failed", String(e));
    return undefined;
  }
}

/** A readable default name for a new passkey, from the browser's user agent. */
export function passkeyLabel(userAgent: string | undefined): string {
  const ua = userAgent ?? "";
  const os = /iPhone|iPad/.test(ua)
    ? "iPhone / iPad"
    : /Android/.test(ua)
      ? "Android"
      : /Mac OS X/.test(ua)
        ? "Mac"
        : /Windows/.test(ua)
          ? "Windows"
          : /Linux/.test(ua)
            ? "Linux"
            : "Device";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "";
  return browser ? `${os} · ${browser}` : os;
}
