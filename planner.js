// GTFS-realtime decoding and journey planning for Hoyt-Schermerhorn -> 51 St.
// Pure functions only; index.html owns fetching and rendering. Also loads in Node for tests.
(function (root) {
  const HOYT = "A42N";
  const FULTON_AC = "A38N";
  const FULTON_45 = "418N";
  const GRAND_CENTRAL = "631N";
  const FIFTY_FIRST = "630N";
  const AC_ROUTES = new Set(["A", "C"]);
  const EXPRESS_ROUTES = new Set(["4", "5"]);
  const LOCAL_ROUTES = new Set(["6", "6X"]);
  const ROUTES = new Set([...AC_ROUTES, ...EXPRESS_ROUTES, ...LOCAL_ROUTES]);

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

  // Returns {timestamp, trips: Map(tripId -> {tripId, route, times: {stopId: [arrive, depart]}, lastStop}),
  //          vehicles: Map(tripId -> {stopId, status, timestamp})}
  function parseFeed(buffer) {
    const bytes = new Uint8Array(buffer);
    const feed = { timestamp: 0, trips: new Map(), vehicles: new Map() };
    eachField(bytes, 0, bytes.length, (field, value) => {
      if (field === 1) {
        eachField(bytes, value[0], value[1], (f, v) => {
          if (f === 3) feed.timestamp = v;
        });
      } else if (field === 2) {
        eachField(bytes, value[0], value[1], (f, v) => {
          if (f === 3) parseTripUpdate(bytes, v, feed);
          else if (f === 4) parseVehicle(bytes, v, feed);
        });
      }
    });
    return feed;
  }

  function parseTripUpdate(bytes, range, feed) {
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
    if (!trip || !ROUTES.has(trip.route) || stops.length === 0) return;
    const times = {};
    for (const stop of stops) {
      times[stop.stopId] = [stop.arrive || stop.depart, stop.depart || stop.arrive];
    }
    feed.trips.set(trip.tripId, { ...trip, times, lastStop: stops[stops.length - 1].stopId });
  }

  function parseVehicle(bytes, range, feed) {
    let trip = null;
    const vehicle = { stopId: "", status: 2, timestamp: 0 };
    eachField(bytes, range[0], range[1], (field, value) => {
      if (field === 1) trip = tripDescriptor(bytes, value);
      else if (field === 7) vehicle.stopId = text(bytes, value);
      else if (field === 4) vehicle.status = value;
      else if (field === 5) vehicle.timestamp = value;
    });
    if (trip && ROUTES.has(trip.route)) feed.vehicles.set(trip.tripId, vehicle);
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

  // Timetabled trips for one service day that the live feed doesn't cover yet: not already
  // live, and boarding later than the latest live prediction for that route at that stop.
  function scheduledTrips(schedule, year, month, day, liveTrips) {
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
    for (const [tripId, route, service, slots] of schedule.trips) {
      if (!services.has(service) || liveTrips.has(tripId)) continue;
      const times = {};
      let first = null;
      slots.forEach((slot, i) => {
        if (!slot) return;
        const stop = schedule.stops[i];
        times[stop] = [origin + slot[0], origin + slot[1]];
        if (first === null || times[stop][1] < times[first][1]) first = stop;
      });
      if (first === null || times[first][1] <= (horizon.get(route + "|" + first) || 0)) continue;
      trips.set("sched:" + tripId, { tripId, route, times, lastStop: null, scheduled: true });
    }
    return trips;
  }

  const board = (trip, stop) => (trip.times[stop] ? trip.times[stop][1] : null);
  const alight = (trip, stop) => (trip.times[stop] ? trip.times[stop][0] : null);

  function byRoute(trips, routes) {
    return [...trips.values()].filter((trip) => routes.has(trip.route));
  }

  // Earliest 6 from Grand Central to 51 St, boarding no sooner than `ready`.
  function bestLocal(locals, ready) {
    let best = null;
    for (const local of locals) {
      const leave = board(local, GRAND_CENTRAL);
      const arrive = alight(local, FIFTY_FIRST);
      if (leave === null || arrive === null || leave < ready || arrive < leave) continue;
      if (!best || arrive < alight(best, FIFTY_FIRST)) best = local;
    }
    return best;
  }

  // Earliest 51 St arrival via a 4/5 boarded at Fulton no sooner than `ready`.
  function bestExpress(expresses, locals, ready, sixTransfer) {
    let best = null;
    for (const express of expresses) {
      const leave = board(express, FULTON_45);
      const reach = alight(express, GRAND_CENTRAL);
      if (leave === null || reach === null || leave < ready || reach < leave) continue;
      const local = bestLocal(locals, reach + sixTransfer);
      if (local && (!best || alight(local, FIFTY_FIRST) < alight(best.local, FIFTY_FIRST))) {
        best = { express, local };
      }
    }
    return best;
  }

  // For every A/C still due at Hoyt, the earliest-arriving connection to 51 St.
  function plan(trips, acTransfer, sixTransfer) {
    const expresses = byRoute(trips, EXPRESS_ROUTES);
    const locals = byRoute(trips, LOCAL_ROUTES);
    const journeys = [];
    for (const ac of byRoute(trips, AC_ROUTES)) {
      const leave = board(ac, HOYT);
      const reach = alight(ac, FULTON_AC);
      if (leave === null || reach === null || reach <= leave) continue;
      const rest = bestExpress(expresses, locals, reach + acTransfer, sixTransfer);
      if (!rest) continue;
      const arrive = alight(rest.local, FIFTY_FIRST);
      journeys.push({ ac, express: rest.express, local: rest.local, depart: leave, arrive, seconds: arrive - leave });
    }
    return journeys;
  }

  // Shortest first, ties to the later departure, one per (depart, arrive).
  function rank(journeys) {
    const unique = new Map();
    for (const journey of journeys) unique.set(journey.depart + ":" + journey.arrive, journey);
    return [...unique.values()].sort((a, b) => a.seconds - b.seconds || b.depart - a.depart);
  }

  // Every 4/5 leaving Fulton after `reach`, each with its resulting 51 St arrival.
  function fultonOptions(trips, reach, sixTransfer, limit) {
    const locals = byRoute(trips, LOCAL_ROUTES);
    return byRoute(trips, EXPRESS_ROUTES)
      .filter((express) => board(express, FULTON_45) > reach && alight(express, GRAND_CENTRAL) !== null)
      .sort((a, b) => board(a, FULTON_45) - board(b, FULTON_45))
      .slice(0, limit)
      .map((express) => {
        const local = bestLocal(locals, alight(express, GRAND_CENTRAL) + sixTransfer);
        return { express, gap: board(express, FULTON_45) - reach, local, arrive: local ? alight(local, FIFTY_FIRST) : null };
      });
  }

  // Every 6 leaving Grand Central at or after `reach`.
  function grandCentralOptions(trips, reach, limit) {
    return byRoute(trips, LOCAL_ROUTES)
      .filter((local) => board(local, GRAND_CENTRAL) >= reach && alight(local, FIFTY_FIRST) !== null)
      .sort((a, b) => board(a, GRAND_CENTRAL) - board(b, GRAND_CENTRAL))
      .slice(0, limit)
      .map((local) => ({ local, gap: board(local, GRAND_CENTRAL) - reach, arrive: alight(local, FIFTY_FIRST) }));
  }

  const api = {
    HOYT, FULTON_AC, FULTON_45, GRAND_CENTRAL, FIFTY_FIRST,
    parseFeed, mergeFeeds, nyFields, nyEpoch, scheduledTrips,
    board, alight, plan, rank, fultonOptions, grandCentralOptions,
  };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.Planner = api;
})(typeof globalThis === "object" ? globalThis : this);
