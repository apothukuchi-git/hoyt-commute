// The commute pages. Each route page sets window.COMMUTE_ID and loads app.js, which reads this.
// Stop IDs are GTFS platform IDs: the N/S suffix is the direction. build_schedule.py keeps the
// timetable for STATIONS and ROUTES below, so a new stop or line has to be added there too.
(function (root) {
  const AC = ["A", "C"];
  const EXPRESS = ["4", "5"];
  // The 4 makes local stops late at night.
  const LEX_LOCAL = ["6", "6X", "4"];
  const SIXTH_AV = ["F", "FX", "M"];
  // Since the F/M swap the F runs with the E through Lexington Av/53 St and Court Sq.
  const QUEENS_53 = ["E", "F", "FX"];
  const CROSSTOWN = ["G"];
  // The M leaves the F at W 4 St, so only the F reaches Jay St.
  const F_ONLY = ["F", "FX"];
  const ACE_FEED = "nyct%2Fgtfs-ace";
  const NUMBERED_FEED = "nyct%2Fgtfs";
  const BDFM_FEED = "nyct%2Fgtfs-bdfm";
  const G_FEED = "nyct%2Fgtfs-g";

  const STOP_NAMES = {
    A42: "Hoyt-Schermerhorn", A41: "Jay St", A38: "Fulton St", A32: "W 4 St",
    418: "Fulton St", 631: "Grand Central", 630: "51 St", 635: "Union Sq",
    D20: "W 4 St", D19: "14 St", F11: "Lex Av-53 St", F09: "Court Sq", G22: "Court Sq",
  };

  // transfers: key -> [label, default minutes]. Each leg after the first names the transfer before it.
  // mode: "window" plans to an arrival window; "now" shows the soonest arrivals leaving from now.
  const COMMUTES = {
    "hoyt-to-51st": {
      from: "Hoyt-Schermerhorn", to: "51 St", fromRoutes: AC, toRoutes: ["4", "5", "6"],
      feeds: [ACE_FEED, NUMBERED_FEED],
      mode: "window", earliest: "09:20", latest: "09:30",
      transfers: { fulton: ["A/C to 4/5 at Fulton St", 1], grandCentral: ["4/5 to 6 at Grand Central", 0] },
      paths: [[
        { routes: AC, from: "A42N", to: "A38N" },
        { routes: EXPRESS, from: "418N", to: "631N", transfer: "fulton" },
        { routes: LEX_LOCAL, from: "631N", to: "630N", transfer: "grandCentral" },
      ]],
    },
    // Starts from either platform of the 51 St / Lexington Av-53 St station.
    "51st-lex-to-hoyt": {
      from: "51 St / Lex Av-53 St", to: "Hoyt-Schermerhorn", fromRoutes: ["6", "E", "F"], toRoutes: ["A", "C", "G"],
      feeds: [NUMBERED_FEED, ACE_FEED, BDFM_FEED, G_FEED],
      mode: "now", earliest: "18:30", latest: "18:45",
      transfers: {
        grandCentral: ["6 to 4/5 at Grand Central", 0],
        fulton: ["4/5 to A/C at Fulton St", 1],
        courtSq: ["E/F to G at Court Sq", 3],
      },
      paths: [
        [
          { routes: LEX_LOCAL, from: "630S", to: "631S" },
          { routes: EXPRESS, from: "631S", to: "418S", transfer: "grandCentral" },
          { routes: AC, from: "A38S", to: "A42S", transfer: "fulton" },
        ],
        [
          { routes: QUEENS_53, from: "F11N", to: "F09N" },
          { routes: CROSSTOWN, from: "G22S", to: "A42S", transfer: "courtSq" },
        ],
      ],
    },
    "union-sq-to-51st": {
      from: "Union Sq", to: "51 St", fromRoutes: ["4", "5", "6"], toRoutes: ["6"],
      feeds: [NUMBERED_FEED],
      mode: "window", earliest: "09:20", latest: "09:30",
      transfers: { grandCentral: ["4/5 to 6 at Grand Central", 0] },
      paths: [
        [{ routes: LEX_LOCAL, from: "635N", to: "630N" }],
        [
          { routes: EXPRESS, from: "635N", to: "631N" },
          { routes: LEX_LOCAL, from: "631N", to: "630N", transfer: "grandCentral" },
        ],
      ],
    },
    "hoyt-to-14st": {
      from: "Hoyt-Schermerhorn", to: "14 St", fromRoutes: AC, toRoutes: ["F", "M"],
      feeds: [ACE_FEED, BDFM_FEED],
      mode: "now", earliest: "09:20", latest: "09:30",
      transfers: { jay: ["A/C to F at Jay St", 1], w4: ["A/C to F/M at W 4 St", 2] },
      paths: [
        [
          { routes: AC, from: "A42N", to: "A41N" },
          { routes: F_ONLY, from: "A41N", to: "D19N", transfer: "jay" },
        ],
        [
          { routes: AC, from: "A42N", to: "A32N" },
          { routes: SIXTH_AV, from: "D20N", to: "D19N", transfer: "w4" },
        ],
      ],
    },
    "14st-to-hoyt": {
      from: "14 St", to: "Hoyt-Schermerhorn", fromRoutes: ["F", "M"], toRoutes: AC,
      feeds: [BDFM_FEED, ACE_FEED],
      mode: "now", earliest: "18:30", latest: "18:45",
      transfers: { w4: ["F/M to A/C at W 4 St", 2], jay: ["F to A/C at Jay St", 1] },
      paths: [
        [
          { routes: SIXTH_AV, from: "D19S", to: "D20S" },
          { routes: AC, from: "A32S", to: "A42S", transfer: "w4" },
        ],
        [
          { routes: F_ONLY, from: "D19S", to: "A41S" },
          { routes: AC, from: "A41S", to: "A42S", transfer: "jay" },
        ],
      ],
    },
  };

  root.Commutes = { COMMUTES, STOP_NAMES };
})(typeof globalThis === "object" ? globalThis : this);
