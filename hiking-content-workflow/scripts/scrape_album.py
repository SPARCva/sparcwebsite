#!/usr/bin/env python3
"""
Google Photos Shared Album Scraper
===================================
Downloads all photos and videos from a Google Photos shared album link.

Usage:
    python scrape_album.py \
        --url "https://photos.app.goo.gl/ezKtUQrdWpnaJqWg7" \
        --output "~/Hiking Content/my-hike"

Requirements:
    pip install requests
    Optional: pip install playwright (for large albums with lazy-loaded content)
"""

import argparse
import os
import re
import sys
import time
from pathlib import Path
from urllib.parse import urlparse

import requests

# Google Photos base URL pattern for media
MEDIA_URL_PATTERN = re.compile(
    r"https://lh3\.googleusercontent\.com/pw/[a-zA-Z0-9_\-/]+"
)

# Video URL indicator patterns in Google Photos page data
VIDEO_INDICATOR = re.compile(r'"video/mp4"')

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)


def resolve_short_url(url):
    """Resolve photos.app.goo.gl short URLs to full Google Photos URLs."""
    if "photos.app.goo.gl" in url:
        response = requests.head(url, allow_redirects=True, timeout=10)
        return response.url
    return url


def fetch_album_page(url):
    """Fetch the Google Photos shared album page HTML."""
    headers = {"User-Agent": USER_AGENT}
    response = requests.get(url, headers=headers, timeout=30)
    response.raise_for_status()
    return response.text


def extract_media_urls(html):
    """Extract all media URLs from the album page."""
    urls = list(set(MEDIA_URL_PATTERN.findall(html)))
    # Filter out tiny thumbnails and UI elements (very short URLs are usually icons)
    urls = [u for u in urls if len(u) > 80]
    return urls


def download_media(url, output_dir, index, max_resolution=True):
    """Download a single media file from Google Photos."""
    # Append resolution parameter for full quality
    # =w0-h0 means original resolution
    # =d means download original
    download_url = f"{url}=d" if max_resolution else f"{url}=w1920-h1920"

    headers = {"User-Agent": USER_AGENT}

    try:
        response = requests.get(download_url, headers=headers, timeout=60, stream=True)
        response.raise_for_status()

        # Determine file extension from content-type
        content_type = response.headers.get("content-type", "image/jpeg")
        if "video" in content_type:
            ext = ".mp4"
            subdir = output_dir / "videos"
        elif "png" in content_type:
            ext = ".png"
            subdir = output_dir / "photos"
        elif "heic" in content_type or "heif" in content_type:
            ext = ".heic"
            subdir = output_dir / "photos"
        else:
            ext = ".jpg"
            subdir = output_dir / "photos"

        subdir.mkdir(parents=True, exist_ok=True)
        filename = f"IMG_{index:04d}{ext}"
        filepath = subdir / filename

        if filepath.exists():
            print(f"  Skipping (exists): {filename}")
            return filepath

        with open(filepath, "wb") as f:
            for chunk in response.iter_content(chunk_size=8192):
                f.write(chunk)

        size_mb = filepath.stat().st_size / (1024 * 1024)
        print(f"  Downloaded: {filename} ({size_mb:.1f} MB)")
        return filepath

    except requests.RequestException as e:
        print(f"  ERROR downloading item {index}: {e}")
        return None


def scrape_album(url, output_dir, max_resolution=True):
    """Scrape all media from a Google Photos shared album."""
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    print(f"Resolving album URL...")
    full_url = resolve_short_url(url)
    print(f"  Album URL: {full_url}")

    print(f"Fetching album page...")
    html = fetch_album_page(full_url)
    print(f"  Page size: {len(html):,} bytes")

    print(f"Extracting media URLs...")
    media_urls = extract_media_urls(html)
    print(f"  Found {len(media_urls)} media items")

    if not media_urls:
        print("\nNo media found. This can happen if:")
        print("  1. The album is empty")
        print("  2. The album requires sign-in")
        print("  3. Content is lazy-loaded (try the --use-browser flag)")
        print(f"\nTo debug, the page starts with: {html[:200]}")
        return []

    print(f"\nDownloading to: {output_dir}")
    downloaded = []
    for i, media_url in enumerate(media_urls, 1):
        print(f"  [{i}/{len(media_urls)}]", end="")
        filepath = download_media(media_url, output_dir, i, max_resolution)
        if filepath:
            downloaded.append(filepath)
        # Polite delay to avoid rate limiting
        time.sleep(0.5)

    print(f"\nDone! Downloaded {len(downloaded)} files to: {output_dir}")
    print(f"  Photos: {output_dir / 'photos'}")
    print(f"  Videos: {output_dir / 'videos'}")
    return downloaded


def scrape_album_with_browser(url, output_dir, max_resolution=True):
    """Use Playwright for albums that need full JS rendering."""
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("ERROR: Playwright is required for --use-browser mode.")
        print("  pip install playwright")
        print("  playwright install chromium")
        sys.exit(1)

    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    print(f"Resolving album URL...")
    full_url = resolve_short_url(url)

    print(f"Launching browser to render album...")
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        page.goto(full_url, wait_until="networkidle")

        # Scroll to load lazy content
        print("  Scrolling to load all content...")
        prev_height = 0
        for _ in range(20):  # Max 20 scroll attempts
            page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
            time.sleep(1)
            curr_height = page.evaluate("document.body.scrollHeight")
            if curr_height == prev_height:
                break
            prev_height = curr_height

        html = page.content()
        browser.close()

    print(f"  Page size after rendering: {len(html):,} bytes")

    media_urls = extract_media_urls(html)
    print(f"  Found {len(media_urls)} media items")

    if not media_urls:
        print("\nNo media found even with browser rendering.")
        print("The album may require sign-in or may be private.")
        return []

    print(f"\nDownloading to: {output_dir}")
    downloaded = []
    for i, media_url in enumerate(media_urls, 1):
        print(f"  [{i}/{len(media_urls)}]", end="")
        filepath = download_media(media_url, output_dir, i, max_resolution)
        if filepath:
            downloaded.append(filepath)
        time.sleep(0.5)

    print(f"\nDone! Downloaded {len(downloaded)} files to: {output_dir}")
    return downloaded


def main():
    parser = argparse.ArgumentParser(
        description="Download photos/videos from a Google Photos shared album"
    )
    parser.add_argument(
        "--url",
        required=True,
        help="Google Photos shared album URL (short or full)",
    )
    parser.add_argument(
        "--output",
        required=True,
        help="Local directory to save downloaded media",
    )
    parser.add_argument(
        "--use-browser",
        action="store_true",
        help="Use Playwright browser for albums with lazy-loaded content",
    )
    parser.add_argument(
        "--preview-quality",
        action="store_true",
        help="Download at preview quality (1920px) instead of original",
    )

    args = parser.parse_args()
    output_dir = os.path.expanduser(args.output)

    if args.use_browser:
        scrape_album_with_browser(
            args.url, output_dir, max_resolution=not args.preview_quality
        )
    else:
        scrape_album(args.url, output_dir, max_resolution=not args.preview_quality)


if __name__ == "__main__":
    main()
