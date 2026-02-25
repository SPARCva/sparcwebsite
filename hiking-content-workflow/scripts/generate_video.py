#!/usr/bin/env python3
"""
Hiking Reel Generator
=====================
Turns a folder of hiking photos + trail metadata + audio into a polished
9:16 vertical video ready for TikTok and Instagram Reels.

Usage:
    python generate_video.py \
        --hike-folder "~/Hiking Content/2026-02-15-sedona" \
        --output "output/sedona-reel.mp4" \
        --handle "@yourusername"

Requirements:
    pip install moviepy>=2.0 Pillow numpy
    ffmpeg must be installed on your system
"""

import argparse
import json
import os
import random
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

try:
    from moviepy import (
        AudioFileClip,
        CompositeVideoClip,
        ImageClip,
        TextClip,
        concatenate_videoclips,
    )
except ImportError:
    print("ERROR: moviepy v2+ is required. Install with: pip install moviepy>=2.0")
    sys.exit(1)


# ── Video Settings ──────────────────────────────────────────────────────────

FULL_WIDTH = 1080
FULL_HEIGHT = 1920
PREVIEW_WIDTH = 540
PREVIEW_HEIGHT = 960
FPS = 30
SUPPORTED_IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".heic", ".webp"}
SUPPORTED_AUDIO_EXTS = {".mp3", ".m4a", ".wav", ".aac", ".ogg"}


# ── Helper Functions ────────────────────────────────────────────────────────


def find_system_font():
    """Find a usable TrueType font on the system."""
    font_paths = [
        # macOS
        "/System/Library/Fonts/Helvetica.ttc",
        "/System/Library/Fonts/SFCompact.ttf",
        "/Library/Fonts/Arial.ttf",
        # Linux
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
        "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
        # Windows
        "C:/Windows/Fonts/arial.ttf",
        "C:/Windows/Fonts/segoeui.ttf",
    ]
    for path in font_paths:
        if os.path.exists(path):
            return path
    return None


def crop_to_portrait(img_path, width, height):
    """Crop and resize an image to exact portrait dimensions (center crop)."""
    img = Image.open(img_path).convert("RGB")
    target_ratio = width / height
    img_ratio = img.width / img.height

    if img_ratio > target_ratio:
        # Image is wider than target — crop sides
        new_width = int(img.height * target_ratio)
        left = (img.width - new_width) // 2
        img = img.crop((left, 0, left + new_width, img.height))
    else:
        # Image is taller than target — crop top/bottom
        new_height = int(img.width / target_ratio)
        top = (img.height - new_height) // 2
        img = img.crop((0, top, img.width, top + new_height))

    img = img.resize((width, height), Image.LANCZOS)
    return np.array(img)


def build_overlay_text(trail_data):
    """Build the text overlay strings from trail metadata."""
    name = trail_data.get("trail_name", "Unknown Trail")
    location = trail_data.get("location", "")
    rating = trail_data.get("alltrails_rating")
    difficulty = trail_data.get("difficulty")
    distance = trail_data.get("distance_miles")
    quote = trail_data.get("quote")

    # Top line: trail name + location
    top_line = name
    if location:
        top_line += f" — {location}"

    # Bottom line: rating info OR quote
    if rating is not None:
        bottom_parts = [f"⭐ {rating} on AllTrails"]
        if difficulty:
            bottom_parts.append(difficulty)
        if distance:
            bottom_parts.append(f"{distance} mi")
        bottom_line = " | ".join(bottom_parts)
    elif quote:
        bottom_line = f'"{quote}"'
    else:
        # Fall back to a random quote from quotes.json if available
        bottom_line = get_random_quote()

    return top_line, bottom_line


def get_random_quote():
    """Load a random nature quote from the quotes file."""
    quotes_path = Path(__file__).parent.parent / "data" / "quotes.json"
    if quotes_path.exists():
        with open(quotes_path) as f:
            quotes = json.load(f)
        if quotes:
            q = random.choice(quotes)
            return f'"{q["text"]}" — {q["author"]}'
    return '"In every walk with nature one receives far more than he seeks." — John Muir'


def find_audio_file(hike_folder):
    """Look for an audio file in the hike folder."""
    folder = Path(hike_folder)
    for ext in SUPPORTED_AUDIO_EXTS:
        for f in folder.glob(f"*{ext}"):
            return str(f)
        # Also check an audio/ subfolder
        for f in folder.glob(f"audio/*{ext}"):
            return str(f)
    return None


def find_photos(hike_folder):
    """Find all photos in the hike folder, sorted by name."""
    folder = Path(hike_folder)
    photos = []
    # Check root and photos/ subfolder
    for search_dir in [folder, folder / "photos"]:
        if search_dir.exists():
            for f in sorted(search_dir.iterdir()):
                if f.suffix.lower() in SUPPORTED_IMAGE_EXTS:
                    photos.append(str(f))
    return photos


def load_trail_data(hike_folder):
    """Load trail-data.json from the hike folder."""
    data_path = Path(hike_folder) / "trail-data.json"
    if data_path.exists():
        with open(data_path) as f:
            return json.load(f)
    return {
        "trail_name": Path(hike_folder).name.replace("-", " ").title(),
        "location": "",
        "alltrails_rating": None,
        "quote": None,
    }


# ── Main Video Generation ──────────────────────────────────────────────────


def generate_video(
    hike_folder,
    output_path,
    duration_per_photo=3,
    transition_duration=0.5,
    handle="",
    font_path=None,
    preview=False,
    no_audio=False,
    max_duration=60,
):
    """Generate a hiking reel video from photos, trail data, and audio."""

    width = PREVIEW_WIDTH if preview else FULL_WIDTH
    height = PREVIEW_HEIGHT if preview else FULL_HEIGHT
    font_size_title = 28 if preview else 56
    font_size_info = 20 if preview else 40
    font_size_handle = 16 if preview else 32

    # Resolve font
    if not font_path:
        font_path = find_system_font()
    if not font_path:
        print("WARNING: No system font found. Text overlays may not render.")
        print("  Install DejaVu fonts or pass --font /path/to/font.ttf")

    # Load inputs
    photos = find_photos(hike_folder)
    if not photos:
        print(f"ERROR: No photos found in {hike_folder}")
        print(f"  Looking for images in: {hike_folder} and {hike_folder}/photos/")
        sys.exit(1)

    trail_data = load_trail_data(hike_folder)
    top_text, bottom_text = build_overlay_text(trail_data)

    # Limit photos to fit max duration
    max_photos = int(max_duration / duration_per_photo)
    if len(photos) > max_photos:
        print(f"NOTE: Limiting to {max_photos} photos to stay under {max_duration}s")
        photos = photos[:max_photos]

    print(f"Generating video from {len(photos)} photos...")
    print(f"  Trail: {top_text}")
    print(f"  Info:  {bottom_text}")
    print(f"  Size:  {width}x{height}")

    # Build clips
    clips = []
    for i, photo_path in enumerate(photos):
        print(f"  Processing photo {i + 1}/{len(photos)}: {Path(photo_path).name}")

        # Create image clip
        img_array = crop_to_portrait(photo_path, width, height)
        img_clip = ImageClip(img_array).with_duration(duration_per_photo)

        layers = [img_clip]

        if font_path:
            # Title text (top area with semi-transparent background)
            title_clip = TextClip(
                font=font_path,
                text=top_text,
                font_size=font_size_title,
                color="white",
                stroke_color="black",
                stroke_width=2,
                method="caption",
                size=(width - 80, None),
                text_align="center",
            ).with_duration(duration_per_photo).with_position(("center", 80))
            layers.append(title_clip)

            # Info text (bottom area)
            info_clip = TextClip(
                font=font_path,
                text=bottom_text,
                font_size=font_size_info,
                color="white",
                stroke_color="black",
                stroke_width=2,
                method="caption",
                size=(width - 80, None),
                text_align="center",
            ).with_duration(duration_per_photo).with_position(("center", height - 200))
            layers.append(info_clip)

            # Handle watermark (bottom-right)
            if handle:
                handle_clip = TextClip(
                    font=font_path,
                    text=handle,
                    font_size=font_size_handle,
                    color="rgba(255,255,255,0.7)",
                    stroke_color="black",
                    stroke_width=1,
                ).with_duration(duration_per_photo).with_position(
                    (width - 300, height - 80)
                )
                layers.append(handle_clip)

        composite = CompositeVideoClip(layers, size=(width, height))
        clips.append(composite)

    # Concatenate with crossfade transitions
    if len(clips) > 1 and transition_duration > 0:
        final_clips = [clips[0]]
        for clip in clips[1:]:
            final_clips.append(
                clip.with_start(
                    final_clips[-1].start
                    + final_clips[-1].duration
                    - transition_duration
                ).cross_fadein(transition_duration)
            )
        video = CompositeVideoClip(final_clips, size=(width, height))
    else:
        video = concatenate_videoclips(clips, method="compose")

    # Add audio
    if not no_audio:
        audio_path = find_audio_file(hike_folder)
        if audio_path:
            print(f"  Adding audio: {Path(audio_path).name}")
            audio = AudioFileClip(audio_path)
            if audio.duration > video.duration:
                audio = audio.subclipped(0, video.duration)
            elif audio.duration < video.duration:
                print(
                    f"  WARNING: Audio ({audio.duration:.1f}s) shorter than "
                    f"video ({video.duration:.1f}s)"
                )
            video = video.with_audio(audio)
        else:
            print("  No audio file found — video will be silent")
            print(f"  To add audio, place an mp3/m4a file in: {hike_folder}")

    # Export
    output_dir = Path(output_path).parent
    output_dir.mkdir(parents=True, exist_ok=True)

    print(f"  Rendering to: {output_path}")
    video.write_videofile(
        str(output_path),
        fps=FPS,
        codec="libx264",
        audio_codec="aac",
        preset="medium" if not preview else "ultrafast",
        threads=4,
    )

    duration = video.duration
    print(f"\nDone! Video: {output_path} ({duration:.1f}s)")
    return output_path


# ── CLI ─────────────────────────────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(
        description="Generate a hiking reel video from photos and trail data"
    )
    parser.add_argument(
        "--hike-folder",
        required=True,
        help="Path to the hike directory containing photos and trail-data.json",
    )
    parser.add_argument(
        "--output",
        default="output/reel.mp4",
        help="Output video file path (default: output/reel.mp4)",
    )
    parser.add_argument(
        "--duration-per-photo",
        type=float,
        default=3,
        help="Seconds each photo displays (default: 3)",
    )
    parser.add_argument(
        "--transition-duration",
        type=float,
        default=0.5,
        help="Crossfade transition duration in seconds (default: 0.5)",
    )
    parser.add_argument(
        "--handle",
        default="",
        help="Your social media handle for watermark",
    )
    parser.add_argument(
        "--font",
        default=None,
        help="Path to a .ttf font file",
    )
    parser.add_argument(
        "--preview",
        action="store_true",
        help="Render at half resolution for quick preview",
    )
    parser.add_argument(
        "--no-audio",
        action="store_true",
        help="Skip audio track",
    )
    parser.add_argument(
        "--max-duration",
        type=float,
        default=60,
        help="Maximum video duration in seconds (default: 60)",
    )

    args = parser.parse_args()

    hike_folder = os.path.expanduser(args.hike_folder)
    if not os.path.isdir(hike_folder):
        print(f"ERROR: Hike folder not found: {hike_folder}")
        sys.exit(1)

    generate_video(
        hike_folder=hike_folder,
        output_path=args.output,
        duration_per_photo=args.duration_per_photo,
        transition_duration=args.transition_duration,
        handle=args.handle,
        font_path=args.font,
        preview=args.preview,
        no_audio=args.no_audio,
        max_duration=args.max_duration,
    )


if __name__ == "__main__":
    main()
