"""Extract the timetable for the commute pages from the MTA's static GTFS into schedule.json.

The browser can't download the GTFS zip itself (no CORS on it), so a GitHub Action runs
this daily and commits the result. Uses the supplemented feed, which folds in planned
service changes for the next 7 days. Standard library only.

    python3 build_schedule.py [output_path]
"""

import csv
import io
import json
import sys
import urllib.request
import zipfile
from datetime import datetime, timezone

SOURCE = "https://rrgtfsfeeds.s3.amazonaws.com/gtfs_supplemented.zip"
# Every station and line routes.js uses, both directions.
STATIONS = ["A42", "A41", "A38", "A32", "418", "631", "630", "635", "D20", "D19", "F11", "F09", "G22", "637", "D21"]
STOPS = [station + direction for station in STATIONS for direction in "NS"]
ROUTES = {"A", "C", "E", "4", "5", "6", "6X", "F", "FX", "M", "G"}


def seconds(hms: str) -> int:
    hours, minutes, secs = map(int, hms.split(":"))
    return hours * 3600 + minutes * 60 + secs


def rows(archive: zipfile.ZipFile, name: str):
    with archive.open(name) as handle:
        yield from csv.DictReader(io.TextIOWrapper(handle, "utf-8-sig"))


def main() -> None:
    output = sys.argv[1] if len(sys.argv) > 1 else "schedule.json"
    request = urllib.request.Request(SOURCE, headers={"User-Agent": "hoyt-commute/1.0"})
    with urllib.request.urlopen(request, timeout=120) as response:
        archive = zipfile.ZipFile(io.BytesIO(response.read()))

    weekdays = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
    services = {
        row["service_id"]: {
            "days": "".join(row[day] for day in weekdays),
            "start": row["start_date"],
            "end": row["end_date"],
        }
        for row in rows(archive, "calendar.txt")
    }
    exceptions: dict[str, dict[str, list[str]]] = {}
    for row in rows(archive, "calendar_dates.txt"):
        kind = "add" if row["exception_type"] == "1" else "remove"
        exceptions.setdefault(row["date"], {"add": [], "remove": []})[kind].append(row["service_id"])

    trips = {
        row["trip_id"]: (row["route_id"], row["service_id"])
        for row in rows(archive, "trips.txt")
        if row["route_id"] in ROUTES
    }
    times: dict[str, list] = {}
    stop_index = {stop: i for i, stop in enumerate(STOPS)}
    for row in rows(archive, "stop_times.txt"):
        if row["stop_id"] in stop_index and row["trip_id"] in trips:
            times.setdefault(row["trip_id"], []).append(
                [stop_index[row["stop_id"]], seconds(row["arrival_time"]), seconds(row["departure_time"])]
            )

    names = {row["stop_id"]: row["stop_name"] for row in rows(archive, "stops.txt") if row["location_type"] == "1"}

    schedule = {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": SOURCE,
        "names": names,
        "stops": STOPS,
        "services": services,
        "exceptions": exceptions,
        # [realtime trip id, route, service_id, [[index into stops, arrive, depart], ...]] with times in
        # seconds after service-day start
        "trips": [
            [trip_id.split("_", 1)[-1], *trips[trip_id], sorted(stops)] for trip_id, stops in sorted(times.items())
        ],
    }
    with open(output, "w") as handle:
        json.dump(schedule, handle, separators=(",", ":"))
    print(f"Wrote {len(schedule['trips'])} trips to {output}")


if __name__ == "__main__":
    main()
