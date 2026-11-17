// architecture.md §4.1: the service worker answers navigations from the cached shell, so a reload
// for a rebuilt daemon must drop that shell first or it would boot the old build again.
const SHELL_KEY = "/";

export async function dropCachedShell(): Promise<void> {
  if (typeof caches === "undefined") return; // plain HTTP modes have no service worker
  const names = await caches.keys();
  await Promise.all(names.map(async (name) => (await caches.open(name)).delete(SHELL_KEY)));
}
