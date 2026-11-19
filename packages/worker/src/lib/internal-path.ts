/**
 * Returns a same-origin absolute path, or `/` when the input could navigate elsewhere.
 *
 * URL parsing is intentional: browsers remove ASCII tabs/newlines before interpreting a URL,
 * so string-prefix checks alone can mistake `/\t/evil.example` for an internal path.
 */
export function safeNext(next: string | undefined, origin: string): string {
  if (!next?.startsWith("/")) return "/";
  try {
    const base = new URL(origin);
    const destination = new URL(next, base);
    // Dot segments can leave a leading `//` (`/.//evil.example`), which a browser reads as another host.
    if (destination.origin !== base.origin || destination.pathname.startsWith("//")) return "/";
    return `${destination.pathname}${destination.search}${destination.hash}`;
  } catch {
    return "/";
  }
}
