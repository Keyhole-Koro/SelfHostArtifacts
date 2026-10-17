/**
 * Browser code for passkeys, served at /assets/passkey.js. Plain JS with no dependencies:
 * it turns the server's JSON options into the binary form navigator.credentials wants, and the
 * credential back into JSON.
 *
 * Buttons opt in with data attributes:
 *   data-passkey="login"     data-options="/auth/passkey/login/options" data-verify="…"
 *   data-passkey="register"  data-options="…" data-verify="…" [data-name-input="#id"]
 * The page may set <meta name="csrf" content="…"> for signed-in requests.
 */
export const PASSKEY_CLIENT_JS = `
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

async function post(url, body) {
  const headers = { "content-type": "application/json" };
  const csrf = document.querySelector('meta[name="csrf"]')?.content;
  if (csrf) headers["x-csrf"] = csrf;
  const res = await fetch(url, { method: "POST", headers, credentials: "same-origin", body: JSON.stringify(body ?? {}) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || "Something went wrong. Try again.");
  return json;
}

function creationOptions(o) {
  return {
    ...o,
    challenge: b64.toBytes(o.challenge),
    user: { ...o.user, id: b64.toBytes(o.user.id) },
    excludeCredentials: (o.excludeCredentials || []).map((c) => ({ ...c, id: b64.toBytes(c.id) })),
  };
}

function requestOptions(o) {
  return {
    ...o,
    challenge: b64.toBytes(o.challenge),
    allowCredentials: (o.allowCredentials || []).map((c) => ({ ...c, id: b64.toBytes(c.id) })),
  };
}

function registrationJSON(cred) {
  const r = cred.response;
  return {
    id: cred.id,
    rawId: b64.from(cred.rawId),
    type: cred.type,
    clientExtensionResults: cred.getClientExtensionResults(),
    authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
    response: {
      clientDataJSON: b64.from(r.clientDataJSON),
      attestationObject: b64.from(r.attestationObject),
      transports: r.getTransports ? r.getTransports() : undefined,
    },
  };
}

function authenticationJSON(cred) {
  const r = cred.response;
  return {
    id: cred.id,
    rawId: b64.from(cred.rawId),
    type: cred.type,
    clientExtensionResults: cred.getClientExtensionResults(),
    authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
    response: {
      clientDataJSON: b64.from(r.clientDataJSON),
      authenticatorData: b64.from(r.authenticatorData),
      signature: b64.from(r.signature),
      userHandle: r.userHandle ? b64.from(r.userHandle) : undefined,
    },
  };
}

function showError(button, message) {
  let el = button.parentElement.querySelector(".passkey-error");
  if (!el) {
    el = document.createElement("p");
    el.className = "passkey-error";
    el.setAttribute("role", "alert");
    button.parentElement.append(el);
  }
  el.textContent = message;
}

async function run(button) {
  const { passkey, options, verify, nameInput } = button.dataset;
  const extra = {};
  if (nameInput) extra.name = document.querySelector(nameInput)?.value.trim();
  button.disabled = true;
  try {
    if (!window.PublicKeyCredential) throw new Error("This browser does not support passkeys.");
    const opts = await post(options, extra);
    let result;
    if (passkey === "login") {
      const cred = await navigator.credentials.get({ publicKey: requestOptions(opts) });
      result = await post(verify, { response: authenticationJSON(cred) });
    } else {
      const cred = await navigator.credentials.create({ publicKey: creationOptions(opts) });
      result = await post(verify, { ...extra, response: registrationJSON(cred) });
    }
    const next = new URL(result.next || location.href, location.href);
    // Moving to the same page with only a different #hash would not reload it.
    if (next.pathname === location.pathname && next.search === location.search) {
      history.replaceState(null, "", next.href);
      location.reload();
    } else {
      location.assign(next.href);
    }
  } catch (e) {
    const name = e && e.name;
    const message =
      name === "NotAllowedError" || name === "AbortError"
        ? passkey === "login"
          ? "No passkey was used. If you have none for this site yet, see below for how to get one."
          : "Cancelled. Try again when you are ready."
        : name === "InvalidStateError"
          ? "This device or password manager already holds a passkey for you. Add one from another device instead."
          : e.message;
    showError(button, message);
    button.disabled = false;
  }
}

document.querySelectorAll("[data-passkey]").forEach((button) => button.addEventListener("click", () => run(button)));
`;
