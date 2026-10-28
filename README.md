# MTA commute

Phone pages that plan subway commutes from the MTA's real-time feeds, directly from the browser
(no API key, no server). Each route has its own page:

- `hoyt-to-51st.html`: Hoyt-Schermerhorn → 51 St, by A/C, 4/5 at Fulton St, and 6 at Grand Central.
- `union-sq-to-51st.html`: Union Sq → 51 St, by the 6 direct or 4/5 with a change to the 6 at Grand Central.
- `51st-lex-to-hoyt.html`: 51 St or Lexington Av-53 St → Hoyt-Schermerhorn, by 6, 4/5 at Grand Central, and A/C at
  Fulton St, by 6, F at Broadway-Lafayette, and A/C at Jay St, or by E/F to Court Sq and the G.
- `hoyt-to-14st.html`: Hoyt-Schermerhorn → 14 St (F/M), by A/C and then F at Jay St or F/M at W 4 St.
- `14st-to-hoyt.html`: 14 St (F/M) → Hoyt-Schermerhorn, the same in reverse.

`index.html` links to all of them.

How it is built:

- `routes.js` describes each route: its legs, its transfers, which feeds to read, and its default mode.
  "Arrive between" picks the shortest trip that arrives inside a window. "Leave now" picks the soonest arrival.
- `app.js` builds and runs a route page. It refreshes every 20 seconds while open, and never more than
  once every 15 seconds.
- `planner.js` decodes GTFS-realtime and finds the best connection for each train.
- `schedule.json` is the timetable for the stops in `routes.js`. The page uses it for trains that the live
  feed has not published yet, because the feed lists a train only about 40 minutes ahead.
  `.github/workflows/schedule.yml` rebuilds it every day from the MTA's supplemented GTFS with `build_schedule.py`.
- `sw.js` keeps the pages on the phone, so they open with no signal.
