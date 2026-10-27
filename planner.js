// GTFS-realtime decoding and journey planning for the commute pages.
// Pure functions only; app.js owns fetching and rendering. Also loads in Node for tests.
(function (root) {
  const utf8 = new TextDecoder();

  // Minimal protobuf wire-format reader. Feed timestamps (~1.8e9) fit in a JS number,
  // so varints are accumulated with multiplication instead of 32-bit bit ops.
  function varint(bytes, cursor) {
    let value = 0;
    let scale = 1;
    let byte;
    do {
      byte = bytes[cursor.i++];
      value += (byte & 0x7f) * scale;
      scale *= 128;
    } while (byte & 0x80);
    return value;
  }

  function eachField(bytes, start, end, visit) {
    const cursor = { i: start };
    while (cursor.i < end) {
      const key = varint(bytes, cursor);
      const field = Math.floor(key / 8);
      const wire = key % 8;
      if (wire === 0) {
        visit(field, varint(bytes, cursor));
      } else if (wire === 2) {
        const length = varint(bytes, cursor);
        visit(field, [cursor.i, cursor.i + length]);
        cursor.i += length;
      } else if (wire === 1) {
        cursor.i += 8;
      } else if (wire === 5) {
        cursor.i += 4;
      } else {
        throw new Error("Unsupported protobuf wire type " + wire);
      }
    }
  }

  const text = (bytes, [start, end]) => utf8.decode(bytes.subarray(start, end));

  function eventTime(bytes, range) {
    let time = 0;
    eachField(bytes, range[0], range[1], (field, value) => {
      if (field === 2) time = value;
    });
    return time;
  }

  function tripDescriptor(bytes, range) {
    const trip = { tripId: "", route: "" };
    eachField(bytes, range[0], range[1], (field, value) => {
      if (field === 1) trip.tripId = text(bytes, value);
      else if (field === 5) trip.route = text(bytes, value);
    });
    return trip;
  }

  // Keeps only trips on `routes` (a Set). Returns
  // {timestamp, trips: Map(tripId -> {tripId, route, times: {stopId: [arrive, depart]}, lastStop}),
  //  vehicles: Map(tripId -> {stopId, status, timestamp})}
  function parseFeed(buffer, routes) {
    const bytes = new Uint8Array(buffer);
    const feed = { timestamp: 0, trips: new Map(), vehicles: new Map() };
    eachField(bytes, 0, bytes.length, (field, value) => {
      if (field === 1) {
        eachField(bytes, value[0], value[1], (f, v) => {
          if (f === 3) feed.timestamp = v;
        });
      } else if (field === 2) {
        eachField(bytes, value[0], value[1], (f, v) => {
          if (f === 3) parseTripUpdate(bytes, v, feed, routes);
          else if (f === 4) parseVehicle(bytes, v, feed, routes);
        });
      }
    });
    return feed;
  }

  function parseTripUpdate(bytes, range, feed, routes) {
    let trip = null;
    const stops = [];
    eachField(bytes, range[0], range[1], (field, value) => {
      if (field === 1) trip = tripDescriptor(bytes, value);
      else if (field === 2) {
        const stop = { stopId: "", arrive: 0, depart: 0 };
        eachField(bytes, value[0], value[1], (f, v) => {
          if (f === 4) stop.stopId = text(bytes, v);
          else if (f === 2) stop.arrive = eventTime(bytes, v);
          else if (f === 3) stop.depart = eventTime(bytes, v);
        });
        stops.push(stop);
      }
    });
    if (!trip || !routes.has(trip.route) || stops.length === 0) return;
    const times = {};
    for (const stop of stops) {
      times[stop.stopId] = [stop.arrive || stop.depart, stop.depart || stop.arrive];
    }
    feed.trips.set(trip.tripId, { ...trip, times, lastStop: stops[stops.length - 1].stopId });
  }

  function parseVehicle(bytes, range, feed, routes) {
    let trip = null;
    const vehicle = { stopId: "", status: 2, timestamp: 0 };
    eachField(bytes, range[0], range[1], (field, value) => {
      if (field === 1) trip = tripDescriptor(bytes, value);
      else if (field === 7) vehicle.stopId = text(bytes, value);
      else if (field === 4) vehicle.status = value;
      else if (field === 5) vehicle.timestamp = value;
    });
    if (trip && routes.has(trip.route)) feed.vehicles.set(trip.tripId, vehicle);
  }

  function mergeFeeds(feeds) {
    const merged = { timestamp: Infinity, trips: new Map(), vehicles: new Map() };
    for (const feed of feeds) {
      merged.timestamp = Math.min(merged.timestamp, feed.timestamp);
      feed.trips.forEach((trip, id) => merged.trips.set(id, trip));
      feed.vehicles.forEach((vehicle, id) => merged.vehicles.set(id, vehicle));
    }
    return merged;
  }

  const nyFormat = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  function nyFields(epoch) {
    const parts = {};
    for (const part of nyFormat.formatToParts(new Date(epoch * 1000))) parts[part.type] = Number(part.value);
    return parts;
  }

  // Epoch seconds for a New York wall-clock time. Two passes so the offset is the one in
  // effect at the result, not at the first guess, which matters only near a DST change.
  function nyEpoch(year, month, day, hour, minute, second) {
    const wall = Date.UTC(year, month - 1, day, hour, minute, second) / 1000;
    let epoch = wall;
    for (let pass = 0; pass < 2; pass++) {
      const f = nyFields(epoch);
      epoch = wall - (Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second) / 1000 - epoch);
    }
    return epoch;
  }

  function activeServices(schedule, year, month, day) {
    const ymd = String(year * 10000 + month * 100 + day);
    const weekday = (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7;
    const active = new Set();
    for (const [id, service] of Object.entries(schedule.services)) {
      if (service.days[weekday] === "1" && service.start <= ymd && ymd <= service.end) active.add(id);
    }
    const exception = schedule.exceptions[ymd];
    if (exception) {
      exception.add.forEach((id) => active.add(id));
      exception.remove.forEach((id) => active.delete(id));
    }
    return active;
  }

  // Timetabled trips on `routes` for one service day that the live feed doesn't cover yet: not
  // already live, and boarding later than the latest live prediction for that route at that stop.
  function scheduledTrips(schedule, year, month, day, liveTrips, routes) {
    const services = activeServices(schedule, year, month, day);
    // GTFS times count from noon minus 12h, which stays correct across DST changes.
    const origin = nyEpoch(year, month, day, 12, 0, 0) - 12 * 3600;
    const horizon = new Map();
    liveTrips.forEach((trip) => {
      for (const [stop, [, depart]] of Object.entries(trip.times)) {
        const key = trip.route + "|" + stop;
        horizon.set(key, Math.max(horizon.get(key) || 0, depart));
      }
    });
    const trips = new Map();
    for (const [tripId, route, service, stops] of schedule.trips) {
      if (!routes.has(route) || !services.has(service) || liveTrips.has(tripId)) continue;
      const times = {};
      let first = null;
      for (const [index, arrive, depart] of stops) {
        const stop = schedule.stops[index];
        times[stop] = [origin + arrive, origin + depart];
        if (first === null || times[stop][1] < times[first][1]) first = stop;
      }
      if (first === null || times[first][1] <= (horizon.get(route + "|" + first) || 0)) continue;
      trips.set("sched:" + tripId, { tripId, route, times, lastStop: null, scheduled: true });
    }
    return trips;
  }

  const board = (trip, stop) => (trip.times[stop] ? trip.times[stop][1] : null);
  const alight = (trip, stop) => (trip.times[stop] ? trip.times[stop][0] : null);

  // A path is a list of legs {routes, from, to}. gaps[i] is the time needed between stepping off
  // leg i-1 and boarding leg i. For every leg, returns its trips sorted by boarding time, each
  // linked to the onward connection that reaches the end soonest:
  // [[{trip, board, alight, next, arrive}, ...] per leg]
  function connections(trips, path, gaps) {
    const legs = path.map((leg) => {
      const routes = new Set(leg.routes);
      const entries = [];
      trips.forEach((trip) => {
        if (!routes.has(trip.route)) return;
        const on = board(trip, leg.from);
        const off = alight(trip, leg.to);
        if (on !== null && off !== null && off > on) entries.push({ trip, board: on, alight: off, next: null, arrive: null });
      });
      return entries.sort((a, b) => a.board - b.board);
    });
    // best[i][k]: of the leg-i entries from index k on, the one that arrives soonest.
    const best = legs.map(() => []);
    for (let i = legs.length - 1; i >= 0; i--) {
      for (const entry of legs[i]) {
        if (i === legs.length - 1) {
          entry.arrive = entry.alight;
        } else {
          entry.next = soonest(legs[i + 1], best[i + 1], entry.alight + gaps[i + 1]);
          entry.arrive = entry.next ? entry.next.arrive : null;
        }
      }
      let leader = null;
      for (let k = legs[i].length - 1; k >= 0; k--) {
        const entry = legs[i][k];
        // Strictly earlier only, so a tie keeps the later train and its longer transfer.
        if (entry.arrive !== null && (!leader || entry.arrive < leader.arrive)) leader = entry;
        best[i][k] = leader;
      }
    }
    return legs;
  }

  // The entry boarding no sooner than `ready` that arrives soonest, by binary search.
  function soonest(entries, best, ready) {
    let lo = 0;
    let hi = entries.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (entries[mid].board < ready) lo = mid + 1;
      else hi = mid;
    }
    return lo < entries.length ? best[lo] : null;
  }

  // For every train still due at the start of each path, the soonest-arriving connection to the end.
  // paths: list of paths; gapsFor(path) -> gaps for that path.
  function plan(trips, paths, gapsFor) {
    const journeys = [];
    paths.forEach((path, index) => {
      for (const first of connections(trips, path, gapsFor(path))[0]) {
        if (first.arrive === null) continue;
        const legs = [];
        for (let entry = first; entry; entry = entry.next) legs.push(entry.trip);
        journeys.push({ path: index, trips: legs, depart: first.board, arrive: first.arrive, seconds: first.arrive - first.board });
      }
    });
    return journeys;
  }

  // Shortest first, ties to the later departure, one per (depart, arrive).
  function rank(journeys) {
    return dedupe(journeys).sort((a, b) => a.seconds - b.seconds || b.depart - a.depart);
  }

  // Soonest arrival first, ties to the later departure, dropping any journey that another one
  // beats on both ends (leaves no earlier and arrives no later).
  function rankByArrival(journeys) {
    const sorted = [...journeys].sort((a, b) => a.arrive - b.arrive || b.depart - a.depart);
    const kept = [];
    for (const journey of sorted) {
      if (!kept.length || journey.depart > kept[kept.length - 1].depart) kept.push(journey);
    }
    return kept;
  }

  function dedupe(journeys) {
    const unique = new Map();
    for (const journey of journeys) unique.set(journey.depart + ":" + journey.arrive, journey);
    return [...unique.values()];
  }

  // The next `limit` trains on leg `index` boarding at or after `reach`, each with its arrival at the end.
  function transferOptions(trips, path, gaps, index, reach, limit) {
    return connections(trips, path, gaps)[index]
      .filter((entry) => entry.board >= reach)
      .slice(0, limit)
      .map((entry) => ({ trip: entry.trip, board: entry.board, gap: entry.board - reach, arrive: entry.arrive, onward: entry }));
  }

  const api = {
    parseFeed, mergeFeeds, nyFields, nyEpoch, scheduledTrips,
    board, alight, connections, plan, rank, rankByArrival, dedupe, transferOptions,
  };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.Planner = api;
})(typeof globalThis === "object" ? globalThis : this);
