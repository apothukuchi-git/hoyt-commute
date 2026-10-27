// One commute page: builds the page for Commutes.COMMUTES[window.COMMUTE_ID], polls the MTA
// feeds it needs, and renders trip plans and the live transfer tracker.
(function () {
  const P = window.Planner;
  const ID = window.COMMUTE_ID;
  const C = window.Commutes.COMMUTES[ID];
  const STOP_NAMES = window.Commutes.STOP_NAMES;
  const BASE = "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/";
  // Rate limits: poll only while visible, and never reach the MTA more than once per
  // MIN_GAP_SECONDS. Requests that die on a dead connection never reached the MTA, so those
  // retry quickly; real MTA errors back off.
  const REFRESH_SECONDS = 20;
  const MIN_GAP_SECONDS = 15;
  const OFFLINE_RETRY_SECONDS = 5;
  const MAX_BACKOFF_SECONDS = 120;
  const FETCH_TIMEOUT_SECONDS = 12;
  const STALE_SECONDS = 90;
  const TRANSFER_OPTIONS = 2;
  const NEARBY_MARGIN_SECONDS = 20 * 60;
  const LEAVE_NOW_SPAN_SECONDS = 60 * 60;
  // Hard floor between trains at every transfer, whatever the settings say, so a held door
  // on the train you're on doesn't cost you the connection.
  const MIN_TRANSFER_SECONDS = 30;
  const STORE_KEY = "mta-commute:" + ID;
  const FEED_STORE_KEY = "mta-commute:" + ID + ":feeds";
  const ROUTES = new Set(C.paths.flat().flatMap((leg) => leg.routes));
  const SAVED_STOPS = new Set(C.paths.flat().flatMap((leg) => [leg.from, leg.to]));

  const $ = (id) => document.getElementById(id);
  const state = {
    schedule: null,
    live: null,
    feeds: {},
    trips: new Map(),
    lastReached: 0,
    nextAttemptAt: 0,
    httpFailures: 0,
    offline: false,
    error: "",
    inFlight: false,
    settings: {
      mode: C.mode,
      earliest: C.earliest,
      latest: C.latest,
      transfers: Object.fromEntries(Object.entries(C.transfers).map(([key, [, minutes]]) => [key, minutes])),
    },
    // {date, path, picks: [tripId per leg]}
    tracking: null,
  };

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  const LINE_COLORS = { A: "ace", C: "ace", E: "ace", F: "ind", M: "ind", B: "ind", D: "ind", G: "g" };

  function bullet(route) {
    const kind = LINE_COLORS[route.replace("X", "")] || "lex";
    return '<span class="bullet ' + kind + '" aria-label="' + escapeHtml(route) + ' train">' + escapeHtml(route.replace("X", "")) + "</span>";
  }

  const stopName = (stop) => STOP_NAMES[stop.slice(0, -1)] || stop;

  function buildPage() {
    const badges = (routes) => '<span class="sign-routes">' + routes.map(bullet).join("") + "</span>";
    const stepper = (field, label) =>
      '<div class="window-end"><label for="' + field + '">' + label + '</label><div class="stepper">' +
      '<button class="ghost" type="button" data-step="' + field + ':-5" aria-label="Five minutes earlier">−5</button>' +
      '<input id="' + field + '" type="time">' +
      '<button class="ghost" type="button" data-step="' + field + ':5" aria-label="Five minutes later">+5</button></div></div>';
    const transferFields = Object.entries(C.transfers).map(([key, [label]]) =>
      '<label for="transfer-' + key + '">' + escapeHtml(label) + ' (min)<input id="transfer-' + key + '" data-transfer="' + key +
      '" type="number" min="0" max="15" step="0.5" inputmode="decimal"></label>').join("");
    document.title = C.from + " to " + C.to;
    document.body.innerHTML =
      '<header class="sign"><div class="wrap">' +
      '<a class="home-link" href="./">‹ All commutes</a>' +
      '<h1 class="sign-title">' + badges(C.fromRoutes) + escapeHtml(C.from) + ' <span aria-hidden="true">→</span> ' + badges(C.toRoutes) + escapeHtml(C.to) + "</h1>" +
      '<div class="rule"></div>' +
      '<div class="status"><span id="status">Loading trains…</span><button id="refresh" type="button">Refresh</button></div>' +
      "</div></header>" +
      '<main class="wrap">' +
      '<section id="tracker" hidden aria-live="polite"></section>' +
      '<section class="card" aria-label="When to travel">' +
      '<div class="modes" role="group" aria-label="Plan by">' +
      '<button type="button" data-mode="window">Arrive between</button><button type="button" data-mode="now">Leave now</button></div>' +
      '<div class="window" id="window">' + stepper("earliest", "Arrive from") + stepper("latest", "Arrive by") + "</div>" +
      "</section>" +
      '<section><h2 id="window-title">Best trips</h2><div id="alerts"></div><div id="plans" class="legs"></div></section>' +
      '<section id="nearby-section" hidden><h2 id="nearby-title"></h2><div id="nearby" class="card nearby"></div></section>' +
      '<details class="card" id="settings"><summary>Transfer times</summary><div class="fields">' + transferFields + "</div>" +
      '<p class="note">Every transfer gets at least 30 seconds between trains, even if set lower. ' +
      "Arrive between picks the shortest trip that arrives inside the window, ties to the later departure. " +
      "Leave now picks the soonest arrival, ties to the later departure.</p></details>" +
      "</main>" +
      '<footer class="wrap"><p class="note" id="footnote">Live predictions from the MTA\'s real-time subway feeds, refreshed every 20 seconds while this page is open.</p></footer>';
  }

  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
      if (saved.settings) {
        Object.assign(state.settings, saved.settings, { transfers: { ...state.settings.transfers, ...saved.settings.transfers } });
      }
      state.tracking = saved.tracking || null;
    } catch (_) { /* storage unavailable: defaults are fine */ }
    syncInputs();
  }

  function syncInputs() {
    $("earliest").value = state.settings.earliest;
    $("latest").value = state.settings.latest;
    for (const key of Object.keys(C.transfers)) $("transfer-" + key).value = state.settings.transfers[key];
    document.querySelectorAll("[data-mode]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.mode === state.settings.mode));
    });
    $("window").hidden = state.settings.mode !== "window";
  }

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ settings: state.settings, tracking: state.tracking }));
    } catch (_) { /* best effort */ }
  }

  const now = () => Date.now() / 1000;
  const nyDate = (epoch) => {
    const f = P.nyFields(epoch);
    return f.year + "-" + String(f.month).padStart(2, "0") + "-" + String(f.day).padStart(2, "0");
  };

  const clockFormat = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
  function clock(epoch) {
    return clockFormat.formatToParts(new Date(epoch * 1000)).filter((p) => p.type !== "dayPeriod").map((p) => p.value).join("").trim();
  }
  const shortClock = (epoch) => clock(epoch).replace(/:\d\d$/, "");

  function countdown(epoch) {
    const seconds = Math.round(epoch - now());
    if (seconds <= 0) return seconds > -60 ? "now" : "gone";
    if (seconds >= 3600) return Math.floor(seconds / 3600) + "h " + String(Math.floor((seconds % 3600) / 60)).padStart(2, "0") + "m";
    return Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
  }

  const mmss = (seconds) => (seconds < 0 ? "-" : "") + Math.floor(Math.abs(seconds) / 60) + ":" + String(Math.round(Math.abs(seconds)) % 60).padStart(2, "0");

  function destination(trip) {
    if (!trip.lastStop || !state.schedule) return "";
    const name = state.schedule.names[trip.lastStop.slice(0, -1)];
    return name ? "to " + name : "";
  }

  const source = (trip) => (trip.scheduled ? '<span class="src sched">timetable</span>' : '<span class="src">live</span>');

  const transferSeconds = (key) => Math.max(MIN_TRANSFER_SECONDS, state.settings.transfers[key] * 60);
  const gapsFor = (path) => path.map((leg) => (leg.transfer ? transferSeconds(leg.transfer) : 0));
  const routeNames = (leg) => [...new Set(leg.routes.map((r) => r.replace("X", "")))].filter((r) => r !== "4" || !leg.routes.includes("6")).join("/");

  // Gap between arriving and the next train leaving, judged against the transfer time you set.
  function gapChip(gap, transfer) {
    const spare = gap - transfer;
    const kind = spare < 0 ? "sprint" : spare < 60 ? "tight" : "easy";
    return '<span class="chip ' + kind + '">' + mmss(gap) + " to transfer · " + kind + "</span>";
  }

  function findTrip(id) {
    return state.trips.get(id) || state.trips.get("sched:" + id) || null;
  }

  function windowBounds() {
    if (state.settings.mode === "now") return { earliest: now(), latest: now() + LEAVE_NOW_SPAN_SECONDS, tomorrow: false };
    const t = P.nyFields(now());
    const at = (hhmm, dayOffset) => {
      const [h, m] = hhmm.split(":").map(Number);
      return P.nyEpoch(t.year, t.month, t.day + dayOffset, h, m, 0);
    };
    let offset = 0;
    if (at(state.settings.latest, 0) <= now()) offset = 1;
    return { earliest: at(state.settings.earliest, offset), latest: at(state.settings.latest, offset), tomorrow: offset === 1 };
  }

  function rebuildTrips() {
    const live = state.live ? state.live.trips : new Map();
    const bounds = windowBounds();
    const f = P.nyFields(bounds.latest);
    const scheduled = state.schedule ? P.scheduledTrips(state.schedule, f.year, f.month, f.day, bounds.tomorrow ? new Map() : live, ROUTES) : new Map();
    state.trips = new Map([...(bounds.tomorrow ? [] : live), ...scheduled]);
  }

  class HttpError extends Error {}

  async function fetchWithTimeout(url, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_SECONDS * 1000);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  // Only the stops this page reads, so the saved copy stays small.
  function saveFeeds() {
    const compact = {};
    for (const [name, feed] of Object.entries(state.feeds)) {
      compact[name] = {
        timestamp: feed.timestamp,
        trips: [...feed.trips.values()].flatMap((t) => {
          const times = {};
          for (const stop of SAVED_STOPS) if (t.times[stop]) times[stop] = t.times[stop];
          return Object.keys(times).length ? [[t.tripId, t.route, times, t.lastStop]] : [];
        }),
        vehicles: [...feed.vehicles.entries()].map(([id, v]) => [id, v.stopId, v.status, v.timestamp]),
      };
    }
    try { localStorage.setItem(FEED_STORE_KEY, JSON.stringify(compact)); } catch (_) { /* best effort */ }
  }

  function restoreFeeds() {
    try {
      const compact = JSON.parse(localStorage.getItem(FEED_STORE_KEY) || "{}");
      for (const [name, feed] of Object.entries(compact)) {
        if (now() - feed.timestamp > 3 * 3600) continue;
        state.feeds[name] = {
          timestamp: feed.timestamp,
          trips: new Map(feed.trips.map(([tripId, route, times, lastStop]) => [tripId, { tripId, route, times, lastStop }])),
          vehicles: new Map(feed.vehicles.map(([id, stopId, status, timestamp]) => [id, { stopId, status, timestamp }])),
        };
      }
    } catch (_) { /* nothing saved */ }
    mergeLive();
  }

  function mergeLive() {
    const feeds = Object.values(state.feeds);
    state.live = feeds.length ? P.mergeFeeds(feeds) : null;
  }

  async function loadSchedule() {
    if (state.schedule) return;
    try {
      const response = await fetchWithTimeout("schedule.json", { cache: "no-cache" });
      if (response.ok) state.schedule = await response.json();
    } catch (_) { /* retried on the next refresh */ }
  }

  // manual: the Refresh button. It may retry a dead connection at once, but still never
  // reaches the MTA within MIN_GAP_SECONDS of the last time it did.
  async function refresh(manual) {
    if (state.inFlight || now() - state.lastReached < MIN_GAP_SECONDS) return;
    if (!manual && now() < state.nextAttemptAt) return;
    if (navigator.onLine === false) {
      state.offline = true;
      state.nextAttemptAt = now() + OFFLINE_RETRY_SECONDS;
      render();
      return;
    }
    state.inFlight = true;
    renderStatus();
    await loadSchedule();
    let outcome = "ok";
    for (const feed of C.feeds) {
      try {
        const response = await fetchWithTimeout(BASE + feed);
        state.lastReached = now();
        if (!response.ok) throw new HttpError("MTA returned HTTP " + response.status);
        state.feeds[feed] = P.parseFeed(await response.arrayBuffer(), ROUTES);
      } catch (error) {
        outcome = error instanceof HttpError ? "http" : "network";
        state.error = error.message || String(error);
        break;
      }
    }
    if (outcome === "ok") {
      state.offline = false;
      state.error = "";
      state.httpFailures = 0;
      state.nextAttemptAt = now() + REFRESH_SECONDS;
    } else if (outcome === "network") {
      state.offline = true;
      state.nextAttemptAt = now() + OFFLINE_RETRY_SECONDS;
    } else {
      state.offline = false;
      state.httpFailures += 1;
      state.nextAttemptAt = now() + Math.min(MAX_BACKOFF_SECONDS, REFRESH_SECONDS * 2 ** state.httpFailures);
    }
    // Keep whichever feeds did arrive, even when another one failed.
    mergeLive();
    if (state.live) saveFeeds();
    state.inFlight = false;
    rebuildTrips();
    render();
  }

  function dataAge() {
    return state.live ? Math.max(0, Math.round(now() - state.live.timestamp)) : null;
  }

  const ago = (seconds) => (seconds < 90 ? seconds + "s" : Math.round(seconds / 60) + " min");

  function renderStatus() {
    const button = $("refresh");
    button.disabled = state.inFlight || now() - state.lastReached < MIN_GAP_SECONDS;
    button.textContent = state.inFlight ? "Refreshing…" : "Refresh";
    const age = dataAge();
    const next = Math.max(0, Math.ceil(state.nextAttemptAt - now()));
    let text;
    if (state.offline) text = "No connection · " + (age === null ? "no saved trains" : "trains as of " + ago(age) + " ago") + " · retrying";
    else if (state.error) text = "MTA error · retrying in " + next + "s";
    else if (age === null) text = "Loading trains…";
    else text = "Feed " + ago(age) + " old · " + (document.hidden ? "paused" : state.inFlight ? "updating" : "next update " + next + "s");
    $("status").textContent = text;
  }

  function statusAlert() {
    const age = dataAge();
    if (state.offline) {
      return '<div class="alert">No connection. ' + (state.live
        ? "Showing trains as of " + clock(state.live.timestamp) + " (" + ago(age) + " ago); predictions may have shifted. "
        : "No saved trains yet. ") + "This updates on its own when you're back in signal.</div>";
    }
    if (state.error) return '<div class="alert error">' + escapeHtml(state.error) + ". " + (state.live ? "Showing the last update. " : "") + "Retrying automatically.</div>";
    if (age !== null && age > STALE_SECONDS) return '<div class="alert">These trains are ' + ago(age) + " old.</div>";
    return "";
  }

  function legLine(trip, leg) {
    const dest = destination(trip);
    return '<div class="leg">' + bullet(trip.route) +
      '<div class="where"><div>' + stopName(leg.from) + " " + clock(P.board(trip, leg.from)) + " → " + stopName(leg.to) + " " + clock(P.alight(trip, leg.to)) + "</div>" +
      (dest ? "<div>" + escapeHtml(dest) + "</div>" : "") + "</div>" + source(trip) + "</div>";
  }

  function journeyCard(journey, isBest) {
    const path = C.paths[journey.path];
    let legs = "";
    path.forEach((leg, i) => {
      if (i > 0) {
        const gap = P.board(journey.trips[i], leg.from) - P.alight(journey.trips[i - 1], path[i - 1].to);
        legs += '<div class="xfer">' + gapChip(gap, transferSeconds(leg.transfer)) + "</div>";
      }
      legs += legLine(journey.trips[i], leg);
    });
    const track = JSON.stringify({ path: journey.path, picks: journey.trips.map((t) => t.tripId) });
    return (
      '<article class="card' + (isBest ? " best" : "") + '">' +
      '<div class="headline"><div class="leave">Leave ' + clock(journey.depart) + '<small data-countdown="' + journey.depart + '"></small></div>' +
      '<div class="travel"><b>' + (journey.seconds / 60).toFixed(1) + "</b> min</div></div>" +
      '<div class="legs">' + legs + "</div>" +
      '<div class="arrive">Arrive ' + escapeHtml(C.to) + " <b>" + clock(journey.arrive) + "</b></div>" +
      '<button class="act" type="button" data-track="' + escapeHtml(track) + '">I\'m on this ' + escapeHtml(journey.trips[0].route.replace("X", "")) + "</button>" +
      "</article>"
    );
  }

  function renderPlans() {
    const bounds = windowBounds();
    const leaveNow = state.settings.mode === "now";
    $("window-title").textContent = leaveNow
      ? "Leave now · soonest arrivals"
      : "Best trips · arrive " + clock(bounds.earliest).replace(/:00$/, "") + "–" + clock(bounds.latest).replace(/:00$/, "") + (bounds.tomorrow ? " tomorrow" : "");
    // The tracker shows the connection banner itself when it's open.
    const alerts = [isTracking() ? "" : statusAlert()];
    if (bounds.tomorrow) alerts.push('<div class="alert">That window has passed for today, so this is tomorrow\'s timetable. Live times start about 40 minutes ahead.</div>');
    $("alerts").innerHTML = alerts.join("");
    if (!state.live && !state.schedule) { $("plans").innerHTML = ""; return; }

    const journeys = P.plan(state.trips, C.paths, gapsFor).filter((j) => j.depart > now() - 30);
    if (leaveNow) {
      const upcoming = P.rankByArrival(journeys.filter((j) => j.depart >= now()));
      renderNearby(journeys.filter((j) => j.depart >= now() && j.depart <= bounds.latest), upcoming[0], null);
      $("plans").innerHTML = upcoming.length
        ? upcoming.slice(0, 3).map((j, i) => journeyCard(j, i === 0)).join("")
        : '<p class="note">No trips in the feed or timetable right now.</p>';
      return;
    }
    const inWindow = P.rank(journeys.filter((j) => j.arrive >= bounds.earliest && j.arrive <= bounds.latest));
    renderNearby(journeys.filter((j) => j.arrive >= bounds.earliest - NEARBY_MARGIN_SECONDS && j.arrive <= bounds.latest + NEARBY_MARGIN_SECONDS), inWindow[0], bounds);
    if (inWindow.length) {
      $("plans").innerHTML = inWindow.slice(0, 3).map((j, i) => journeyCard(j, i === 0)).join("");
      return;
    }
    const soonest = P.rankByArrival(journeys.filter((j) => j.depart >= now())).slice(0, 2);
    $("plans").innerHTML =
      '<p class="note">No trip arrives inside the window with these transfer times.' + (soonest.length ? " The next trips leaving now:" : "") + "</p>" +
      soonest.map((j) => journeyCard(j, false)).join("");
  }

  // Window mode: every trip arriving within 20 minutes either side of the window, by arrival
  // time, so a shorter trip just outside the window is easy to spot. Leave-now mode (no
  // bounds): every trip leaving in the next hour, by departure. Rows keep their open state across refreshes.
  function renderNearby(journeys, best, bounds) {
    const rows = P.dedupe(journeys).sort(bounds
      ? (a, b) => a.arrive - b.arrive || b.depart - a.depart
      : (a, b) => a.depart - b.depart || a.arrive - b.arrive);
    $("nearby-section").hidden = rows.length === 0;
    $("nearby-title").textContent = (bounds ? "Around your window" : "Leaving in the next hour") + " · tap a trip for details";
    const open = new Set([...document.querySelectorAll("#nearby details[open]")].map((d) => d.dataset.key));
    const shortest = rows.length ? Math.min(...rows.map((j) => j.seconds)) : 0;
    $("nearby").innerHTML = rows.map((j) => {
      const key = j.path + ":" + j.trips.map((t) => t.tripId).join(":");
      const inside = !bounds || (j.arrive >= bounds.earliest && j.arrive <= bounds.latest);
      const isBest = best && best.depart === j.depart && best.arrive === j.arrive;
      const tag = isBest ? "best" : j.seconds === shortest ? "fastest" : inside ? "" : j.arrive < bounds.earliest ? "early" : "late";
      const timetable = j.trips.some((t) => t.scheduled);
      const [first, second] = bounds ? [j.arrive, j.depart] : [j.depart, j.arrive];
      return '<details data-key="' + escapeHtml(key) + '" class="' + (inside ? "inside" : "outside") + (isBest ? " top" : "") + '"' + (open.has(key) ? " open" : "") + ">" +
        '<summary><span class="t">' + shortClock(first) + "</span>" +
        '<span class="routes">' + (bounds ? "leave " : "arrive ") + shortClock(second) + " " + j.trips.map((t) => bullet(t.route)).join("") + (timetable ? ' <span class="src sched">timetable</span>' : "") + "</span>" +
        '<span class="dur">' + (j.seconds / 60).toFixed(1) + "m</span>" +
        '<span class="tag">' + tag + "</span></summary>" +
        journeyCard(j, false) + "</details>";
    }).join("");
  }

  function shiftTime(hhmm, minutes) {
    const [h, m] = hhmm.split(":").map(Number);
    const total = (((h * 60 + m + minutes) % 1440) + 1440) % 1440;
    return String(Math.floor(total / 60)).padStart(2, "0") + ":" + String(total % 60).padStart(2, "0");
  }

  const isTracking = () => Boolean(state.tracking && state.tracking.date === nyDate(now()) && C.paths[state.tracking.path]);

  // Walks the tracked path from the leg you're on now: where that train is, then the next
  // trains at each transfer (tap the one you catch), following your picks as far as they go.
  function renderTracker() {
    const box = $("tracker");
    if (!isTracking()) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    const path = C.paths[state.tracking.path];
    const picks = state.tracking.picks;
    const trips = path.map((_, i) => (picks[i] ? findTrip(picks[i]) : null));
    const reach = (i) => (trips[i] ? P.alight(trips[i], path[i].to) : null);
    let current = 0;
    while (current < path.length - 1 && reach(current + 1) !== null && (reach(current) === null || reach(current) < now())) current++;

    const onRoute = trips[current] ? trips[current].route : path[current].routes[0];
    let html = statusAlert() + '<div class="card best"><div class="track-head"><h3>Tracking your ' + bullet(onRoute) + "</h3>" +
      '<button class="ghost" type="button" data-stop>Stop</button></div>';

    for (let i = current; i < path.length; i++) {
      const trip = trips[i];
      const leg = path[i];
      if (!trip || reach(i) === null) {
        html += i === current
          ? '<div class="alert">This train has left the live feed. If you\'re already past ' + stopName(leg.to) + ", pick your next train from a trip card, or stop tracking.</div>"
          : '<div class="alert">Your ' + routeNames(leg) + " isn't in the feed right now. Pick another from the list above.</div>";
        break;
      }
      const leaves = P.board(trip, leg.from);
      if (i === current && leaves > now()) {
        html += '<div><div class="big-eta">Leaves ' + stopName(leg.from) + " " + clock(leaves) + ' <span class="sub" data-countdown="' + leaves + '"></span></div></div>';
      }
      html += '<div><div class="big-eta">' + (i === current ? "Reaches " : "Your " + escapeHtml(trip.route.replace("X", "")) + " reaches ") + stopName(leg.to) + " " + clock(reach(i)) +
        ' <span class="sub" data-countdown="' + reach(i) + '"></span></div>' +
        (i === current ? '<div class="sub">' + escapeHtml(vehicleLine(trip)) + (trip.scheduled ? " · timetable, not yet live" : "") + "</div>" : "") + "</div>";
      if (i === path.length - 1) break;
      const next = path[i + 1];
      const options = P.transferOptions(state.trips, path, gapsFor(path), i + 1, reach(i), TRANSFER_OPTIONS);
      html += "<h2>" + routeNames(next) + " at " + stopName(next.from) + " · tap the one you catch</h2>" +
        optionList(options, i + 1, transferSeconds(next.transfer), picks[i + 1]);
      if (!picks[i + 1]) break;
    }
    box.innerHTML = html + "</div>";
  }

  function vehicleLine(trip) {
    const vehicle = state.live && state.live.vehicles.get(trip.tripId);
    if (!vehicle || !vehicle.stopId || !state.schedule) return "";
    const name = state.schedule.names[vehicle.stopId.slice(0, -1)] || vehicle.stopId;
    const verb = ["Arriving at", "Stopped at", "Heading to"][vehicle.status] || "Near";
    return verb + " " + name + (vehicle.timestamp ? " (" + Math.max(0, Math.round(now() - vehicle.timestamp)) + "s ago)" : "");
  }

  function optionList(options, legIndex, transfer, chosenId) {
    if (!options.length) return '<p class="note">No trains in the feed yet.</p>';
    return '<div class="options">' + options.map((o) =>
      '<button class="option' + (o.trip.tripId === chosenId ? " chosen" : "") + '" type="button" data-pick="' + legIndex + ":" + escapeHtml(o.trip.tripId) + '">' +
      bullet(o.trip.route) +
      '<div><div class="when">' + clock(o.board) + "</div><div>" + gapChip(o.gap, transfer) + " " + source(o.trip) + "</div></div>" +
      '<div class="then">' + escapeHtml(C.to) + "<br><b>" + (o.arrive ? clock(o.arrive) : "—") + "</b></div></button>"
    ).join("") + "</div>";
  }

  // Picking a train at a transfer replaces the rest of the plan with that train's best onward connection.
  function pick(legIndex, tripId) {
    const path = C.paths[state.tracking.path];
    const option = P.transferOptions(state.trips, path, gapsFor(path), legIndex, -Infinity, Infinity).find((o) => o.trip.tripId === tripId);
    const picks = state.tracking.picks.slice(0, legIndex);
    for (let entry = option ? option.onward : null; entry; entry = entry.next) picks.push(entry.trip.tripId);
    if (!option) picks.push(tripId);
    state.tracking.picks = picks;
  }

  function tickCountdowns() {
    document.querySelectorAll("[data-countdown]").forEach((el) => {
      const value = countdown(Number(el.dataset.countdown));
      el.textContent = value === "now" ? "now" : value === "gone" ? "left" : "in " + value;
    });
    renderStatus();
  }

  function render() {
    renderTracker();
    renderPlans();
    tickCountdowns();
    if (state.schedule) $("footnote").textContent = "Live predictions from the MTA's real-time subway feeds, refreshed every 20 seconds while this page is open. Legs marked timetable come from the MTA schedule (built " + new Date(state.schedule.generated).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" }) + ") and switch to live about 40 minutes ahead.";
  }

  let wakeLock = null;
  async function keepAwake(on) {
    try {
      if (on && !wakeLock && navigator.wakeLock) wakeLock = await navigator.wakeLock.request("screen");
      if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
    } catch (_) { wakeLock = null; }
  }

  function bindEvents() {
    document.addEventListener("click", (event) => {
      const track = event.target.closest("[data-track]");
      const picked = event.target.closest("[data-pick]");
      const step = event.target.closest("[data-step]");
      const mode = event.target.closest("[data-mode]");
      if (step) {
        const [field, minutes] = step.dataset.step.split(":");
        state.settings[field] = shiftTime(state.settings[field], Number(minutes));
        if (state.settings.earliest > state.settings.latest) {
          if (field === "earliest") state.settings.latest = state.settings.earliest;
          else state.settings.earliest = state.settings.latest;
        }
        syncInputs();
        rebuildTrips();
      } else if (mode) {
        state.settings.mode = mode.dataset.mode;
        syncInputs();
        rebuildTrips();
      } else if (track) {
        state.tracking = { date: nyDate(now()), ...JSON.parse(track.dataset.track) };
        keepAwake(true);
        window.scrollTo({ top: 0, behavior: "smooth" });
      } else if (picked) {
        const split = picked.dataset.pick.indexOf(":");
        pick(Number(picked.dataset.pick.slice(0, split)), picked.dataset.pick.slice(split + 1));
      } else if (event.target.closest("[data-stop]")) {
        state.tracking = null;
        keepAwake(false);
      } else if (event.target.id === "refresh") {
        refresh(true);
        return;
      } else {
        return;
      }
      save();
      render();
    });

    document.addEventListener("change", (event) => {
      const input = event.target;
      if (input.id === "earliest" || input.id === "latest") {
        state.settings[input.id] = input.value || C[input.id];
      } else if (input.dataset.transfer) {
        state.settings.transfers[input.dataset.transfer] = Math.max(0, Number(input.value) || 0);
      } else {
        return;
      }
      save();
      rebuildTrips();
      render();
    });

    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) {
        state.nextAttemptAt = 0;
        refresh(false);
        if (state.tracking) keepAwake(true);
      }
      renderStatus();
    });

    setInterval(() => {
      tickCountdowns();
      if (!document.hidden) refresh(false);
    }, 1000);

    // Back in signal: try right away instead of waiting out the retry timer.
    window.addEventListener("online", () => {
      state.nextAttemptAt = 0;
      refresh(false);
    });
    window.addEventListener("offline", () => {
      state.offline = true;
      render();
    });
  }

  // Keeps the pages, planner and timetable on the phone so a reload underground still opens.
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

  buildPage();
  bindEvents();
  load();
  restoreFeeds();
  rebuildTrips();
  render();
  refresh(true);
})();
