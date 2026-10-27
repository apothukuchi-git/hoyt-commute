# Hoyt to 51 St

A phone page that plans the A/C → 4/5 → 6 trip from Hoyt-Schermerhorn to 51 St, using the MTA's
real-time subway feeds directly from the browser (no API key, no server).

- `index.html`: the page. It refreshes every 20 seconds while open, never more than once per 15 seconds.
- `planner.js`: decodes GTFS-realtime and picks the shortest trip that arrives inside your window.
- `schedule.json`: timetable for these five stops, for trains the live feed hasn't published yet
  (it lists a train about 40 minutes ahead). Rebuilt daily by `.github/workflows/schedule.yml`
  from the MTA's supplemented GTFS via `build_schedule.py`.
