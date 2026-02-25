# Hiking Content Creation Workflow

## Automated Pipeline: Google Photos → Video Reels → TikTok & Instagram

This workflow turns your hiking photos and videos into polished, trend-optimized
Reels and TikToks with location overlays, AllTrails ratings, trending audio, and
strategic hashtags.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Phase 1: Capture & Organize](#phase-1-capture--organize)
3. [Phase 2: Trail Data & Enrichment](#phase-2-trail-data--enrichment)
4. [Phase 3: Trending Audio Selection](#phase-3-trending-audio-selection)
5. [Phase 4: Video Assembly (Automated)](#phase-4-video-assembly-automated)
6. [Phase 5: Polish in CapCut (Optional)](#phase-5-polish-in-capcut-optional)
7. [Phase 6: Claude Review & Caption Generation](#phase-6-claude-review--caption-generation)
8. [Phase 7: Publish](#phase-7-publish)
9. [Tool Setup Guide](#tool-setup-guide)
10. [Weekly Content Calendar](#weekly-content-calendar)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    HIKING CONTENT PIPELINE                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────┐    ┌──────────┐    ┌───────────┐    ┌──────────┐ │
│  │  Google   │───▶│  Trail   │───▶│  Video    │───▶│ CapCut   │ │
│  │  Photos/  │    │  Data +  │    │ Assembly  │    │ Polish   │ │
│  │  Drive    │    │  Audio   │    │ (MoviePy) │    │(Optional)│ │
│  └──────────┘    └──────────┘    └───────────┘    └──────────┘ │
│       │               │               │                │        │
│       ▼               ▼               ▼                ▼        │
│  Sync hiking     AllTrails +      Auto-generate     Add final   │
│  photos to a     nature quotes    9:16 video        transitions │
│  local folder    + trending       with overlays     & effects   │
│                  audio                                          │
│                                                                  │
│  ┌──────────┐    ┌──────────┐    ┌───────────┐                 │
│  │  Claude   │───▶│ Schedule │───▶│  TikTok   │                 │
│  │  Review + │    │ & Post   │    │  + Insta   │                 │
│  │  Captions │    │          │    │  Reels     │                 │
│  └──────────┘    └──────────┘    └───────────┘                 │
│       │               │               │                         │
│       ▼               ▼               ▼                         │
│  Generate         Buffer/Later     Publish with                 │
│  hashtags +       scheduling       trending audio               │
│  captions                          + hashtags                   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Phase 1: Capture & Organize

### The Problem with Google Photos API

As of March 31, 2025, Google Photos API **no longer allows** apps to browse your
full library or access specific albums programmatically. The new Picker API
requires manual user selection each time.

### Recommended Solution: Google Drive Sync

Use Google Drive as your media hub instead:

1. **On your phone**, install Google Drive and set up automatic camera upload
   — OR manually move your best hiking shots into a dedicated Drive folder.

2. **Create a folder structure in Google Drive:**
   ```
   My Drive/
   └── Hiking Content/
       └── 2026-02-15-sedona-cathedral-rock/
           ├── photos/
           │   ├── IMG_001.jpg
           │   ├── IMG_002.jpg
           │   └── IMG_003.jpg
           ├── videos/
           │   └── summit-pan.mp4
           └── trail-data.json     ← you'll create this
       └── 2026-02-22-grand-canyon-rim/
           ├── photos/
           └── videos/
   ```

3. **Sync to your computer** using Google Drive for Desktop, which creates a
   local mirror at `~/Google Drive/Hiking Content/`

4. **Alternative: Use the Google Drive API** to pull files programmatically.
   The Drive API still supports full folder access with OAuth2.

### Quick Setup: Google Drive API

```bash
pip install google-api-python-client google-auth-oauthlib
```

Then use the helper in `scripts/sync_drive.py` (included in this repo) to pull
your latest hike folder to a local working directory.

---

## Phase 2: Trail Data & Enrichment

For each hike, you need: **trail name, location, rating, and a text overlay.**

### Option A: AllTrails Lookup (Manual — Recommended)

AllTrails has no public API and actively blocks scraping. The most reliable
approach is a quick manual lookup:

1. Search your trail on [alltrails.com](https://www.alltrails.com)
2. Record the data in `trail-data.json` for each hike folder:

```json
{
  "trail_name": "Cathedral Rock Trail",
  "location": "Sedona, Arizona",
  "alltrails_rating": 4.7,
  "difficulty": "Moderate",
  "distance_miles": 1.2,
  "elevation_gain_ft": 744,
  "tags": ["sunset", "scramble", "views"],
  "date_hiked": "2026-02-15",
  "quote": null
}
```

When `alltrails_rating` is present, the video overlay will show:
```
📍 Cathedral Rock Trail — Sedona, AZ
⭐ 4.7 on AllTrails | Moderate | 1.2 mi
```

### Option B: No AllTrails Data — Use a Nature Quote

When you can't find the trail on AllTrails (or it's an unmarked trail), set
`alltrails_rating` to `null` and add a `quote`:

```json
{
  "trail_name": "Hidden Creek Falls",
  "location": "Blue Ridge Mountains, NC",
  "alltrails_rating": null,
  "difficulty": null,
  "distance_miles": null,
  "elevation_gain_ft": null,
  "tags": ["waterfall", "hidden-gem"],
  "date_hiked": "2026-02-22",
  "quote": "The mountains are calling and I must go. — John Muir"
}
```

The video overlay will then show:
```
📍 Hidden Creek Falls — Blue Ridge Mountains, NC
"The mountains are calling and I must go." — John Muir
```

### Nature Quote Bank

See `quotes.json` for 50+ curated nature/hiking quotes. The video script
automatically picks a random one when no AllTrails data is available and no
custom quote is set.

### Alternative Data Sources (Programmatic)

| Source | Best For | URL |
|--------|----------|-----|
| National Park Service API | US national park trails | https://www.nps.gov/subjects/developer/api-documentation.htm |
| OpenStreetMap Overpass API | Trail GPS data worldwide | https://overpass-turbo.eu/ |
| Recreation.gov API | Federal recreation areas | https://ridb.recreation.gov/docs |

---

## Phase 3: Trending Audio Selection

Trending audio is the single biggest factor for algorithmic reach on both
TikTok and Instagram Reels. Audio must be **baked into the video file** before
upload — neither platform's API supports adding music after the fact.

### How to Find Trending Audio

**Weekly routine (5 minutes):**

1. **TikTok Creative Center** (free, official):
   - Go to [TikTok Creative Center](https://ads.tiktok.com/business/creativecenter/inspiration/popular/music/pc/en)
   - Filter by your country → Songs → Last 7 days
   - Note the top 3-5 songs trending in outdoor/lifestyle content

2. **Instagram Trending Tab** (in-app):
   - Open Instagram → Create Reel → Tap music icon → "Trending" tab
   - Look for the upward arrow icon next to audio names
   - Follow [@creators](https://www.instagram.com/creators/) for weekly updates

3. **Third-party tools:**
   | Tool | What It Does | Cost |
   |------|-------------|------|
   | [Tokchart](https://tokchart.com) | Weekly trending TikTok audio with graphs | Free |
   | [FeedGuardians](https://feedguardians.com/tools/music-finder) | AI music finder by niche | Free |
   | [HeyOrca](https://www.heyorca.com/blog/trending-audio-for-reels-tiktok) | Weekly updated trending spreadsheet | Free |
   | [Later](https://later.com/blog/instagram-reels-trends/) | Weekly Instagram Reels trends | Free |
   | [Buffer](https://buffer.com/resources/how-to-find-trending-tiktok-sounds/) | Cross-platform trending lists | Free |

4. **CapCut's built-in library:**
   - CapCut surfaces trending sounds directly in the editor
   - Great for discovering audio before it peaks

### Audio Workflow

1. Find a trending sound using the tools above
2. Download or screen-record the audio clip (15-60 seconds)
3. Save to your hike folder as `audio.mp3` or `audio.m4a`
4. The video assembly script will sync it automatically

**Important notes:**
- Business/brand accounts must use commercially licensed audio
- For personal creator accounts, trending sounds are fine for organic posts
- Sounds often trend on TikTok first, then hit Instagram 1-2 weeks later
  — early adoption on Instagram gives an algorithmic boost

---

## Phase 4: Video Assembly (Automated)

This is where automation saves the most time. The Python script
`scripts/generate_video.py` takes your photos, trail data, and audio, and
produces a polished 9:16 Reel ready for posting.

### What the Script Does

1. Loads all photos from the hike folder
2. Resizes/crops each to 1080x1920 (9:16 portrait)
3. Applies a Ken Burns (slow zoom/pan) effect per photo
4. Adds text overlays:
   - Trail name + location (top)
   - AllTrails rating + difficulty OR nature quote (bottom)
   - Your handle/watermark
5. Adds smooth crossfade transitions between photos
6. Syncs the trending audio track
7. Exports as H.264 MP4 at 30fps

### Usage

```bash
# Generate a video from a hike folder
python scripts/generate_video.py \
  --hike-folder "~/Google Drive/Hiking Content/2026-02-15-sedona-cathedral-rock" \
  --output "output/sedona-reel.mp4" \
  --duration-per-photo 3 \
  --handle "@yourusername"

# Preview mode (lower quality, faster render)
python scripts/generate_video.py \
  --hike-folder "~/Google Drive/Hiking Content/2026-02-15-sedona-cathedral-rock" \
  --output "output/sedona-preview.mp4" \
  --preview
```

### Configuration Options

| Flag | Default | Description |
|------|---------|-------------|
| `--hike-folder` | required | Path to the hike directory |
| `--output` | `output/reel.mp4` | Output video path |
| `--duration-per-photo` | `3` | Seconds each photo displays |
| `--transition-duration` | `0.5` | Crossfade duration in seconds |
| `--handle` | `""` | Your social media handle for watermark |
| `--font` | system default | Path to .ttf font file |
| `--preview` | `false` | Render at 540x960 for quick preview |
| `--no-audio` | `false` | Skip audio track |
| `--max-duration` | `60` | Cap total video length (seconds) |

### Requirements

```bash
pip install moviepy>=2.0 Pillow numpy
# Also requires ffmpeg installed on your system
# macOS: brew install ffmpeg
# Ubuntu: sudo apt install ffmpeg
# Windows: download from ffmpeg.org
```

---

## Phase 5: Polish in CapCut (Optional)

For the best results, import the auto-generated video into CapCut for
final touches that are hard to automate:

### CapCut Enhancement Checklist

- [ ] **Replace/adjust audio** — CapCut's trending audio library may have
      better options than what you found manually
- [ ] **Add beat-synced transitions** — align photo transitions to music drops
- [ ] **Apply color grading** — CapCut's "outdoor" and "nature" LUTs work great
- [ ] **Add subtle motion graphics** — animated location pins, star ratings
- [ ] **Fine-tune text animations** — entrance/exit effects on overlays
- [ ] **Add auto-captions** — if your video includes speaking/narration
- [ ] **Adjust speed ramps** — slow-mo for dramatic landscape reveals

### CapCut Template Workflow

1. Create a reusable template in CapCut with your brand fonts, colors, and
   layout preferences
2. Each week, import the auto-generated video and apply the template
3. This takes 5-10 minutes vs. building from scratch each time

### Alternative: Adobe Express

Adobe Express works well for:
- Creating thumbnail/cover images for your Reels
- Designing Instagram carousel posts from your hike photos
- Quick text-based story graphics

Adobe Express does not have an external API for video rendering, but the
in-app editor is excellent for supplementary content.

---

## Phase 6: Claude Review & Caption Generation

Use Claude to review your content and generate optimized captions + hashtags.

### How to Use Claude for This

Copy the prompt template from `prompts/caption-generator.md` and provide:
- Your trail data (from `trail-data.json`)
- The content type (Reel, TikTok, carousel)
- Your target audience
- Any specific vibe or theme

### What Claude Generates

1. **Platform-specific captions** (different for TikTok vs Instagram)
2. **3-5 strategic hashtags** per post (rotated to avoid repetition penalty)
3. **Hook text** (first line that makes people stop scrolling)
4. **Call-to-action** (comment prompts, save prompts)
5. **Alt text** for accessibility
6. **Posting time recommendation**

### Example Output

```
INSTAGRAM REEL CAPTION:
────────────────────────
Cathedral Rock at golden hour hits different ✨

This Sedona classic is only 1.2 miles but don't let that fool you —
the scramble to the saddle will test your grip and your nerve. Worth
every second for these views.

📍 Cathedral Rock Trail, Sedona AZ
⭐ 4.7 on AllTrails | Moderate

Save this for your next Arizona trip 🏜️

#sedonahiking #cathedralrock #arizonatrails #hikingadventures #sunsetreels

────────────────────────
TIKTOK CAPTION:
────────────────────────
POV: You scrambled up Cathedral Rock for golden hour 🌄

#sedonahiking #cathedralrock #arizonahikes #hikertok #trailviews
```

---

## Phase 7: Publish

### Option A: Manual Posting (Recommended for Starting Out)

1. **Transfer video** to your phone (AirDrop, Google Drive, email to self)
2. **Post to TikTok:**
   - Open TikTok → + → Upload → Select video
   - Add caption + hashtags from Claude's output
   - Select a trending sound if you want to replace/layer audio
   - Post or schedule
3. **Post to Instagram:**
   - Open Instagram → + → Reel → Select video
   - Add caption + hashtags
   - Add location tag
   - Share to Feed + Reels
   - Optionally share to Stories with a "New Reel" sticker

### Option B: Scheduling Tools

| Tool | TikTok | Instagram | Free Tier |
|------|--------|-----------|-----------|
| [Buffer](https://buffer.com) | Yes | Yes | 3 channels, 10 posts/channel |
| [Later](https://later.com) | Yes | Yes | 1 social set, 5 posts/month |
| [Hootsuite](https://hootsuite.com) | Yes | Yes | Limited free trial |

### Option C: API Posting (Advanced)

**TikTok Content Posting API:**
- Register an app at [TikTok for Developers](https://developers.tiktok.com)
- Request `video.upload` scope
- **Note:** Unaudited apps can only post privately. You must pass TikTok's
  audit review for public posts.
- Upload flow: init → upload video bytes → poll for status
- Rate limit: 6 requests/minute per user

**Instagram Graph API:**
- Requires Instagram Business or Creator account linked to a Facebook Page
- `POST /{ig-user-id}/media` with `media_type=REELS`
- `POST /{ig-user-id}/media_publish` to finalize
- Audio must be embedded in the video file (API cannot add music)

See `scripts/post_to_social.py` for a reference implementation.

---

## Tool Setup Guide

### Required Tools

| Tool | Purpose | Install |
|------|---------|---------|
| Python 3.10+ | Script execution | python.org |
| MoviePy 2.x | Video assembly | `pip install moviepy>=2.0` |
| FFmpeg | Video encoding backend | brew/apt/ffmpeg.org |
| Pillow | Image processing | `pip install Pillow` |
| Google Drive for Desktop | Photo sync | drive.google.com |

### Recommended Tools (Already Available to You)

| Tool | Best Used For |
|------|---------------|
| **CapCut** | Final polish: transitions, effects, trending audio, captions |
| **Canva** | Cover images, carousel posts, story graphics |
| **Adobe Express** | Thumbnail design, brand templates, quick edits |
| **TikTok** | Posting + discovering trending sounds |
| **Instagram** | Posting + Reels-specific features |
| **Claude** | Caption writing, hashtag strategy, content review |

### Optional Additions

| Tool | Purpose | Cost |
|------|---------|------|
| [Buffer](https://buffer.com) | Cross-platform scheduling | Free tier available |
| [Tokchart](https://tokchart.com) | Trending TikTok audio tracking | Free |
| [Later](https://later.com) | Visual content calendar + scheduling | Free tier available |

---

## Weekly Content Calendar

### Suggested Posting Schedule

| Day | Platform | Content Type | Notes |
|-----|----------|-------------|-------|
| Tuesday | TikTok | Reel from weekend hike | Early in the week = less competition |
| Wednesday | Instagram | Same Reel (re-edited without TikTok watermark) | Remove watermark or Instagram penalizes reach |
| Thursday | Instagram | Carousel post (best 5-7 photos) | Carousels get high engagement |
| Saturday | TikTok | Quick trail preview / "hiking tomorrow" teaser | Build anticipation |
| Sunday | Instagram Stories | Behind-the-scenes from the hike | Stories drive profile visits |

### Content Batch Processing Workflow

**Sunday evening (after your hike):**
1. Transfer photos/videos to Google Drive hike folder (5 min)
2. Fill in `trail-data.json` with AllTrails info (2 min)

**Monday evening (batch processing):**
1. Find trending audio for the week (5 min)
2. Run `generate_video.py` to create base video (2 min)
3. Import into CapCut for polish (10-15 min)
4. Ask Claude for captions + hashtags (2 min)
5. Schedule posts for the week via Buffer/Later (5 min)

**Total weekly time: ~30-40 minutes for 4-5 pieces of content**

---

## File Structure in This Repo

```
hiking-content-workflow/
├── WORKFLOW.md              ← You are here
├── scripts/
│   ├── generate_video.py    ← Main video assembly script
│   ├── sync_drive.py        ← Google Drive folder sync helper
│   └── requirements.txt     ← Python dependencies
├── prompts/
│   └── caption-generator.md ← Claude prompt template for captions
├── data/
│   ├── quotes.json          ← 50+ nature/hiking quotes
│   ├── hashtags.json        ← Curated hashtag sets by category
│   └── trail-data-template.json ← Template for per-hike metadata
└── examples/
    └── example-trail-data.json  ← Example filled-in trail data
```
