#!/usr/bin/env python3
"""
Trail Detector
==============
Extracts GPS coordinates from hiking photos/videos, then looks up the trail
name and location using OpenStreetMap and generates AllTrails search links.

Creates or updates trail-data.json in the hike folder.

Usage:
    python detect_trail.py --hike-folder "~/Hiking Content/my-hike"

Requirements:
    pip install Pillow requests
    Optional: sudo apt install libimage-exiftool-perl  (for video GPS)
    Optional: pip install pyexiftool  (for video GPS)
"""

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

from PIL import Image
from PIL.ExifTags import GPSTAGS, TAGS

import requests

SUPPORTED_IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".heic", ".webp", ".tiff"}
SUPPORTED_VIDEO_EXTS = {".mp4", ".mov", ".m4v", ".avi", ".mkv"}

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
NOMINATIM_URL = "https://nominatim.openstreetmap.org/reverse"
USER_AGENT = "HikingContentWorkflow/1.0"


# ── GPS Extraction ──────────────────────────────────────────────────────────


def dms_to_decimal(dms, ref):
    """Convert GPS degrees/minutes/seconds to decimal degrees."""
    degrees = float(dms[0])
    minutes = float(dms[1])
    seconds = float(dms[2])
    decimal = degrees + minutes / 60.0 + seconds / 3600.0
    if ref in ("S", "W"):
        decimal = -decimal
    return decimal


def get_gps_from_image(image_path):
    """Extract GPS coordinates from an image's EXIF data."""
    try:
        img = Image.open(image_path)
        exif_data = img._getexif()
        if not exif_data:
            return None

        gps_info = {}
        for tag_id, value in exif_data.items():
            tag = TAGS.get(tag_id, tag_id)
            if tag == "GPSInfo":
                for gps_tag_id in value:
                    gps_tag = GPSTAGS.get(gps_tag_id, gps_tag_id)
                    gps_info[gps_tag] = value[gps_tag_id]

        if "GPSLatitude" not in gps_info or "GPSLongitude" not in gps_info:
            return None

        lat = dms_to_decimal(
            gps_info["GPSLatitude"], gps_info.get("GPSLatitudeRef", "N")
        )
        lon = dms_to_decimal(
            gps_info["GPSLongitude"], gps_info.get("GPSLongitudeRef", "W")
        )
        return (lat, lon)
    except Exception:
        return None


def get_gps_from_video(video_path):
    """Extract GPS coordinates from a video using ExifTool."""
    try:
        result = subprocess.run(
            ["exiftool", "-json", "-GPSLatitude", "-GPSLongitude", str(video_path)],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode != 0:
            return None

        data = json.loads(result.stdout)
        if not data:
            return None

        entry = data[0]
        lat = entry.get("GPSLatitude")
        lon = entry.get("GPSLongitude")

        if lat is None or lon is None:
            return None

        # ExifTool may return as string like "34 deg 5' 12.34\" N"
        # or as a float. Handle both.
        if isinstance(lat, str):
            lat = parse_exiftool_gps(lat)
            lon = parse_exiftool_gps(lon)

        return (float(lat), float(lon))
    except (FileNotFoundError, subprocess.TimeoutExpired, json.JSONDecodeError):
        return None


def parse_exiftool_gps(gps_string):
    """Parse ExifTool GPS string like '34 deg 5\\' 12.34\" N' to decimal."""
    match = re.match(
        r"(\d+)\s*deg\s*(\d+)'\s*([\d.]+)\"\s*([NSEW])", gps_string
    )
    if match:
        d, m, s, ref = match.groups()
        decimal = float(d) + float(m) / 60.0 + float(s) / 3600.0
        if ref in ("S", "W"):
            decimal = -decimal
        return decimal
    # Try plain float
    try:
        return float(gps_string)
    except ValueError:
        return None


def find_gps_in_folder(hike_folder):
    """Scan all photos and videos in a folder for GPS data."""
    folder = Path(hike_folder)
    gps_points = []

    # Check photos
    for search_dir in [folder, folder / "photos"]:
        if not search_dir.exists():
            continue
        for f in sorted(search_dir.iterdir()):
            if f.suffix.lower() in SUPPORTED_IMAGE_EXTS:
                coords = get_gps_from_image(str(f))
                if coords:
                    gps_points.append({"file": f.name, "lat": coords[0], "lon": coords[1]})

    # Check videos
    for search_dir in [folder, folder / "videos"]:
        if not search_dir.exists():
            continue
        for f in sorted(search_dir.iterdir()):
            if f.suffix.lower() in SUPPORTED_VIDEO_EXTS:
                coords = get_gps_from_video(str(f))
                if coords:
                    gps_points.append({"file": f.name, "lat": coords[0], "lon": coords[1]})

    return gps_points


# ── Trail Lookup ────────────────────────────────────────────────────────────


def find_trails_overpass(lat, lon, radius_meters=500):
    """Query OpenStreetMap Overpass API for named trails near coordinates."""
    query = f"""
    [out:json][timeout:30];
    (
      way["highway"="path"]["name"](around:{radius_meters},{lat},{lon});
      way["highway"="footway"]["name"](around:{radius_meters},{lat},{lon});
      way["highway"="track"]["name"](around:{radius_meters},{lat},{lon});
      relation["route"="hiking"](around:{radius_meters},{lat},{lon});
      relation["route"="foot"](around:{radius_meters},{lat},{lon});
    );
    out body;
    >;
    out skel qt;
    """

    try:
        response = requests.get(
            OVERPASS_URL,
            params={"data": query},
            headers={"User-Agent": USER_AGENT},
            timeout=30,
        )
        response.raise_for_status()
        data = response.json()

        trails = []
        seen_names = set()
        for element in data.get("elements", []):
            tags = element.get("tags", {})
            name = tags.get("name")
            if name and name not in seen_names:
                seen_names.add(name)
                trails.append(
                    {
                        "name": name,
                        "type": element.get("type"),
                        "sac_scale": tags.get("sac_scale"),
                        "surface": tags.get("surface"),
                    }
                )
        return trails
    except requests.RequestException:
        return []


def reverse_geocode(lat, lon):
    """Get a human-readable location name from coordinates using Nominatim."""
    try:
        response = requests.get(
            NOMINATIM_URL,
            params={
                "format": "json",
                "lat": lat,
                "lon": lon,
                "zoom": 14,
                "addressdetails": 1,
            },
            headers={"User-Agent": USER_AGENT},
            timeout=10,
        )
        response.raise_for_status()
        data = response.json()

        address = data.get("address", {})
        # Build a nice location string
        parts = []

        # Try to get the most specific useful name
        for key in [
            "leisure",
            "tourism",
            "natural",
            "park",
            "nature_reserve",
            "national_park",
        ]:
            if key in address:
                parts.append(address[key])
                break

        # City/town
        for key in ["city", "town", "village", "hamlet", "county"]:
            if key in address:
                parts.append(address[key])
                break

        # State
        state = address.get("state", "")
        if state:
            parts.append(state)

        return ", ".join(parts) if parts else data.get("display_name", "Unknown")
    except requests.RequestException:
        return "Unknown location"


def build_alltrails_url(lat, lon, delta=0.05):
    """Generate an AllTrails explore URL centered on the given coordinates."""
    return (
        f"https://www.alltrails.com/explore"
        f"?b_tl_lat={lat + delta}&b_tl_lng={lon - delta}"
        f"&b_br_lat={lat - delta}&b_br_lng={lon + delta}"
    )


def build_alltrails_search_url(trail_name):
    """Generate an AllTrails search URL from a trail name."""
    query = trail_name.replace(" ", "+")
    return f"https://www.alltrails.com/explore?q={query}"


# ── Main Logic ──────────────────────────────────────────────────────────────


def detect_trail(hike_folder, radius=500):
    """Detect trail info from photos/videos in a hike folder."""
    folder = Path(hike_folder)

    print(f"Scanning for GPS data in: {folder}")
    gps_points = find_gps_in_folder(folder)

    if not gps_points:
        print("  No GPS data found in any photos or videos.")
        print("  Tips:")
        print("    - Make sure location services were ON when photos were taken")
        print("    - Google Photos may strip EXIF when downloading via browser")
        print("    - Try downloading originals via Google Takeout instead")
        return None

    print(f"  Found GPS data in {len(gps_points)} files:")
    for p in gps_points[:5]:
        print(f"    {p['file']}: ({p['lat']:.6f}, {p['lon']:.6f})")
    if len(gps_points) > 5:
        print(f"    ... and {len(gps_points) - 5} more")

    # Use the median GPS point (most representative)
    lats = sorted([p["lat"] for p in gps_points])
    lons = sorted([p["lon"] for p in gps_points])
    median_lat = lats[len(lats) // 2]
    median_lon = lons[len(lons) // 2]
    print(f"\n  Median coordinates: ({median_lat:.6f}, {median_lon:.6f})")

    # Look up trail name from OSM
    print(f"\n  Searching OpenStreetMap for trails within {radius}m...")
    trails = find_trails_overpass(median_lat, median_lon, radius)

    trail_name = None
    if trails:
        trail_name = trails[0]["name"]
        print(f"  Found trail: {trail_name}")
        if len(trails) > 1:
            print(f"  Other nearby trails:")
            for t in trails[1:5]:
                print(f"    - {t['name']}")
    else:
        # Expand search radius
        print(f"  No trails found. Expanding search to {radius * 3}m...")
        trails = find_trails_overpass(median_lat, median_lon, radius * 3)
        if trails:
            trail_name = trails[0]["name"]
            print(f"  Found trail: {trail_name}")

    # Reverse geocode for location
    print(f"\n  Reverse geocoding location...")
    location = reverse_geocode(median_lat, median_lon)
    print(f"  Location: {location}")

    # Build AllTrails URLs
    alltrails_map_url = build_alltrails_url(median_lat, median_lon)
    alltrails_search_url = (
        build_alltrails_search_url(trail_name) if trail_name else None
    )

    # Build trail data
    trail_data = {
        "trail_name": trail_name or folder.name.replace("-", " ").title(),
        "location": location,
        "alltrails_rating": None,
        "difficulty": None,
        "distance_miles": None,
        "elevation_gain_ft": None,
        "tags": [],
        "date_hiked": "",
        "quote": None,
        "_gps": {
            "latitude": median_lat,
            "longitude": median_lon,
            "source_files": len(gps_points),
        },
        "_alltrails_urls": {
            "map_search": alltrails_map_url,
            "text_search": alltrails_search_url,
        },
        "_detected_trail_name": trail_name,
        "_nearby_trails": [t["name"] for t in trails[:5]],
    }

    # Write trail-data.json
    output_path = folder / "trail-data.json"
    existing = {}
    if output_path.exists():
        with open(output_path) as f:
            existing = json.load(f)

    # Only overwrite fields that are empty/null in existing data
    for key in ["trail_name", "location"]:
        if not existing.get(key):
            existing[key] = trail_data[key]

    # Always update detection metadata
    for key in ["_gps", "_alltrails_urls", "_detected_trail_name", "_nearby_trails"]:
        existing[key] = trail_data[key]

    # Fill in template fields if missing
    for key in [
        "alltrails_rating",
        "difficulty",
        "distance_miles",
        "elevation_gain_ft",
        "tags",
        "date_hiked",
        "quote",
    ]:
        if key not in existing:
            existing[key] = trail_data[key]

    with open(output_path, "w") as f:
        json.dump(existing, f, indent=2)

    print(f"\n  Wrote: {output_path}")
    print(f"\n  === ACTION NEEDED ===")
    print(f"  1. Open AllTrails to verify and get rating/difficulty:")
    if alltrails_search_url:
        print(f"     Search: {alltrails_search_url}")
    print(f"     Map:    {alltrails_map_url}")
    print(f"  2. Edit {output_path} to fill in:")
    print(f"     - alltrails_rating (e.g., 4.7)")
    print(f"     - difficulty (e.g., 'Moderate')")
    print(f"     - distance_miles, elevation_gain_ft")
    print(f"     - tags (e.g., ['sunset', 'views'])")
    print(f"     - date_hiked (e.g., '2026-02-15')")
    if not trail_name:
        print(f"     - trail_name (auto-detection failed)")
        print(f"     - quote (add a nature quote since AllTrails may not have it)")

    return trail_data


def main():
    parser = argparse.ArgumentParser(
        description="Detect trail info from photo/video GPS data"
    )
    parser.add_argument(
        "--hike-folder",
        required=True,
        help="Path to the hike directory containing photos/videos",
    )
    parser.add_argument(
        "--radius",
        type=int,
        default=500,
        help="Search radius in meters for trail lookup (default: 500)",
    )

    args = parser.parse_args()
    hike_folder = os.path.expanduser(args.hike_folder)

    if not os.path.isdir(hike_folder):
        print(f"ERROR: Folder not found: {hike_folder}")
        sys.exit(1)

    detect_trail(hike_folder, args.radius)


if __name__ == "__main__":
    main()
