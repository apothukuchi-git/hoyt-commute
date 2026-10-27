// Offline shell for the commute pages. Same-origin files only: MTA feed requests go straight
// to the network, and the page keeps its own saved copy of the last good trains.
const CACHE = "mta-commute-v1";
const SHELL = [
  "./", "./index.html", "./style.css", "./routes.js", "./planner.js", "./app.js", "./schedule.json",
  "./hoyt-to-51st.html", "./union-sq-to-51st.html", "./51st-lex-to-hoyt.html", "./hoyt-to-14st.html", "./14st-to-hoyt.html",
];
const NETWORK_WAIT_MS = 4000;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  event.respondWith(networkFirst(event.request));
});

// Fresh copy when the network answers quickly; the cached copy when it doesn't or is down.
async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  const network = fetch(request).then((response) => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  });
  const cached = await cache.match(request, { ignoreSearch: true });
  if (!cached) return network;
  const timeout = new Promise((resolve) => setTimeout(() => resolve(cached), NETWORK_WAIT_MS));
  return Promise.race([network.catch(() => cached), timeout]);
}
