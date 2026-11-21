/**
 * The script every app page loads from /assets/ui.js:
 * - times show the reader's own time zone and language (the server writes UTC);
 * - menus (details[data-menu]) close when another opens, on Escape, and on a click elsewhere,
 *   also a click into a page's frame;
 * - sections of a menu (details[data-section]) open one at a time;
 * - [data-copy] buttons copy their value;
 * - forms with data-confirm ask first.
 */
export const UI_JS = `(() => {
  const lang = document.documentElement.lang || undefined;
  const exact = new Intl.DateTimeFormat(lang, { dateStyle: "medium", timeStyle: "short" });
  const thisYear = new Intl.DateTimeFormat(lang, { month: "short", day: "numeric" });
  const withYear = new Intl.DateTimeFormat(lang, { year: "numeric", month: "short", day: "numeric" });
  for (const t of document.querySelectorAll("time[datetime]")) {
    const d = new Date(t.getAttribute("datetime"));
    if (isNaN(d.getTime())) continue;
    t.title = exact.format(d);
    if (t.hasAttribute("data-day")) t.textContent = (d.getFullYear() === new Date().getFullYear() ? thisYear : withYear).format(d);
    if (t.hasAttribute("data-exact")) t.textContent = exact.format(d);
  }
  const openMenus = () => [...document.querySelectorAll("details[data-menu][open]")];
  document.addEventListener("toggle", (e) => {
    const d = e.target;
    if (!(d instanceof HTMLDetailsElement) || !d.open) return;
    if (d.hasAttribute("data-menu")) for (const o of openMenus()) if (o !== d && !o.contains(d) && !d.contains(o)) o.open = false;
    if (d.hasAttribute("data-section")) for (const o of d.parentElement.querySelectorAll(":scope > details[data-section][open]")) if (o !== d) o.open = false;
  }, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") for (const o of openMenus()) o.open = false; });
  document.addEventListener("click", (e) => { for (const o of openMenus()) if (!o.contains(e.target)) o.open = false; });
  window.addEventListener("blur", () => setTimeout(() => {
    if (document.activeElement && document.activeElement.tagName === "IFRAME") for (const o of openMenus()) o.open = false;
  }));
  document.addEventListener("submit", (e) => {
    const f = e.target;
    if (f instanceof HTMLFormElement && f.dataset.confirm && !window.confirm(f.dataset.confirm)) e.preventDefault();
  }, true);
  for (const b of document.querySelectorAll("button[data-copy]")) {
    b.addEventListener("click", async () => {
      const text = b.dataset.copy.startsWith("/") ? location.origin + b.dataset.copy : b.dataset.copy;
      const label = b.textContent;
      try { await navigator.clipboard.writeText(text); b.textContent = b.dataset.copied || "✓"; }
      catch { window.prompt("", text); }
      setTimeout(() => { b.textContent = label; }, 1500);
    });
  }
})();`;
