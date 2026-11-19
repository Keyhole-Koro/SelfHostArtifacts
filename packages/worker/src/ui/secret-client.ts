import { SECRET_CRYPTO_JS } from "@artifact/shared";

/**
 * Browser code for the recipient's page (/secret/:token), served at /assets/secret.js.
 *
 * The first visit makes an ECDH key pair whose private key cannot be exported, keeps it in
 * IndexedDB under the request id, and sends the public key. Later visits in the same browser find
 * the key, wait for the sender, then decrypt and show the items. Another browser sees only that
 * the link is taken. Everything is built with textContent, never innerHTML.
 *
 * Share mode: the ciphertext is already there, and its key comes from the part of the link after
 * #, which the browser never sends. Nothing is registered until the person presses Show (link
 * previews open links too). Then the AES key from the # is kept in IndexedDB as a key that cannot
 * be exported, next to the ECDH key, and the # is taken out of the address bar.
 */
export const SECRET_CLIENT_JS = `${SECRET_CRYPTO_JS}
(() => {
  const root = document.getElementById("secret");
  const view = document.getElementById("secret-view");
  if (!root || !view) return;
  const T = JSON.parse(root.dataset.strings);
  const id = root.dataset.id;
  const mode = root.dataset.mode || "request";
  const linkSecret = /^[A-Za-z0-9_-]{43}$/.test(location.hash.slice(1)) ? location.hash.slice(1) : null;
  const forgetHash = () => {
    if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  };
  const base = location.pathname.replace(/\\/+$/, "");
  for (const t of root.querySelectorAll("time[datetime]")) {
    t.textContent = new Date(t.dateTime).toLocaleString(document.documentElement.lang, { dateStyle: "medium", timeStyle: "short" });
  }

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "onclick") node.addEventListener("click", v);
      else node.setAttribute(k, v);
    }
    for (const child of children) node.append(child);
    return node;
  }
  const show = (...nodes) => view.replaceChildren(...nodes);
  const say = (text, error) => show(el("p", error ? { class: "secret-error" } : {}, text));

  // ---- The key, kept in this browser only ----
  function openDb() {
    return new Promise((ok, fail) => {
      const req = indexedDB.open("artifact-secrets", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("keys", { keyPath: "id" });
      req.onsuccess = () => ok(req.result);
      req.onerror = () => fail(req.error);
    });
  }
  async function keys(mode, fn) {
    const db = await openDb();
    return new Promise((ok, fail) => {
      const tx = db.transaction("keys", mode);
      const req = fn(tx.objectStore("keys"));
      tx.oncomplete = () => { db.close(); ok(req.result); };
      tx.onerror = tx.onabort = () => { db.close(); fail(tx.error); };
    });
  }
  const loadKey = () => keys("readonly", (s) => s.get(id));
  const saveKey = (rec) => keys("readwrite", (s) => s.put(rec));
  const dropKey = () => keys("readwrite", (s) => s.delete(id)).catch(() => {});

  async function call(path, body) {
    const init = body === undefined
      ? { credentials: "omit", cache: "no-store" }
      : { method: "POST", credentials: "omit", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
    const res = await fetch(base + path, init);
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, json };
  }

  async function fingerprint(publicKey) {
    return el("div", { class: "secret-fp" },
      el("div", { class: "muted small" }, T.fingerprint),
      el("div", { class: "code" }, await secretCrypto.fingerprint(publicKey)),
      el("p", { class: "muted small" }, T.fingerprintHint));
  }

  function items(list) {
    const rows = list.map((item) => {
      const value = el("div", { class: "value" }, "••••••••");
      let shown = false;
      const toggle = el("button", { type: "button", class: "quiet" }, T.show);
      toggle.addEventListener("click", () => {
        shown = !shown;
        value.textContent = shown ? item.value : "••••••••";
        toggle.textContent = shown ? T.hide : T.show;
      });
      const copy = el("button", { type: "button", class: "quiet" }, T.copy);
      copy.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(item.value);
          copy.textContent = T.copied;
          setTimeout(() => (copy.textContent = T.copy), 1500);
        } catch {
          shown = true;
          value.textContent = item.value;
          toggle.textContent = T.hide;
        }
      });
      return el("li", {}, el("div", { class: "name" }, item.name), value, el("div", { class: "actions" }, toggle, copy));
    });
    const done = el("button", { type: "button", class: "primary" }, T.done);
    done.addEventListener("click", async () => {
      done.disabled = true;
      const res = await call("/received", {});
      if (!res.ok && res.status !== 404) {
        done.disabled = false;
        return;
      }
      await dropKey();
      say(T.finished);
    });
    show(el("p", {}, T.ready), el("ul", { class: "secret-items" }, ...rows), el("div", {}, done));
  }

  async function showSealed(rec) {
    const sealed = await call("/sealed");
    if (!sealed.ok) return say(T.gone);
    let plain;
    try {
      plain = await secretCrypto.decrypt(rec.privateKey, rec.publicKey, id, sealed.json.envelope);
      if (mode === "share") plain = await secretCrypto.openShare(rec.shareKey, plain);
    } catch {
      return say(T.decryptFailed, true);
    }
    items(plain.items || []);
  }

  // ---- Share mode: the ciphertext is already there; the first browser to press Show reads it ----
  async function runShare(state, rec) {
    if (state.json.status === "waiting") {
      if (!linkSecret) return say(T.linkBroken, true);
      const open = el("button", { type: "button", class: "primary" }, T.open);
      open.addEventListener("click", () => {
        open.disabled = true;
        claimShare(rec).catch(() => say(T.error, true));
      });
      return show(el("p", {}, T.shareIntro), el("div", {}, open));
    }
    forgetHash();
    if (!rec || !rec.shareKey || rec.publicKey !== state.json.public_key) {
      if (rec) await dropKey();
      return say(T.otherBrowser, true);
    }
    return showSealed(rec);
  }

  async function claimShare(rec) {
    say(T.preparing);
    let shareKey;
    try {
      shareKey = await secretCrypto.shareKey(linkSecret);
    } catch {
      return say(T.linkBroken, true);
    }
    try {
      if (!rec) {
        const pair = await secretCrypto.generate();
        rec = { id, privateKey: pair.privateKey, publicKey: pair.publicKey, created_at: new Date().toISOString() };
      }
      rec.shareKey = shareKey;
      await saveKey(rec);
    } catch {
      return say(T.storage, true);
    }
    const claim = await call("/claim", { public_key: rec.publicKey });
    if (!claim.ok && claim.status !== 409) return say(T.error, true);
    const state = await call("/state");
    if (!state.ok) return say(T.gone);
    return runShare(state, rec);
  }

  async function run() {
    let state = await call("/state");
    if (!state.ok) return say(T.gone);
    let rec;
    try {
      rec = await loadKey();
    } catch {
      return say(T.storage, true);
    }
    if (mode === "share") return runShare(state, rec);
    if (state.json.status === "waiting") {
      say(T.preparing);
      if (!rec) {
        try {
          const pair = await secretCrypto.generate();
          rec = { id, privateKey: pair.privateKey, publicKey: pair.publicKey, created_at: new Date().toISOString() };
          await saveKey(rec);
        } catch {
          return say(T.storage, true);
        }
      }
      const claim = await call("/claim", { public_key: rec.publicKey });
      if (!claim.ok && claim.status !== 409) return say(T.error, true);
      state = await call("/state");
      if (!state.ok) return say(T.gone);
    }
    if (!rec || rec.publicKey !== state.json.public_key) {
      if (rec) await dropKey();
      return say(T.otherBrowser, true);
    }
    if (state.json.status === "claimed") {
      show(el("p", {}, T.waiting), await fingerprint(rec.publicKey));
      setTimeout(() => run().catch(() => say(T.error, true)), 5000);
      return;
    }
    return showSealed(rec);
  }

  run().catch(() => say(T.error, true));
})();
`;
