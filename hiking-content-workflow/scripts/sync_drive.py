#!/usr/bin/env python3
"""
Google Drive Folder Sync
========================
Downloads photos and videos from a specific Google Drive folder to a local
directory for processing by the video generation pipeline.

Setup:
    1. Go to https://console.cloud.google.com/
    2. Create a project and enable the Google Drive API
    3. Create OAuth 2.0 credentials (Desktop app)
    4. Download the credentials JSON and save as credentials.json
    5. Run this script — it will open a browser for authorization on first run

Usage:
    python sync_drive.py \
        --folder-name "2026-02-15-sedona-cathedral-rock" \
        --output "~/Hiking Content/2026-02-15-sedona-cathedral-rock"

Requirements:
    pip install google-api-python-client google-auth-oauthlib
"""

import argparse
import io
import os
import sys
from pathlib import Path

try:
    from google.auth.transport.requests import Request
    from google.oauth2.credentials import Credentials
    from google_auth_oauthlib.flow import InstalledAppFlow
    from googleapiclient.discovery import build
    from googleapiclient.http import MediaIoBaseDownload
except ImportError:
    print("ERROR: Google API libraries required.")
    print("  pip install google-api-python-client google-auth-oauthlib")
    sys.exit(1)

SCOPES = ["https://www.googleapis.com/auth/drive.readonly"]
TOKEN_PATH = Path(__file__).parent / "token.json"
CREDENTIALS_PATH = Path(__file__).parent / "credentials.json"


def get_drive_service():
    """Authenticate and return a Google Drive API service."""
    creds = None

    if TOKEN_PATH.exists():
        creds = Credentials.from_authorized_user_file(str(TOKEN_PATH), SCOPES)

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            if not CREDENTIALS_PATH.exists():
                print(f"ERROR: {CREDENTIALS_PATH} not found.")
                print("  Download OAuth credentials from Google Cloud Console")
                print("  and save as credentials.json in the scripts/ directory.")
                sys.exit(1)
            flow = InstalledAppFlow.from_client_secrets_file(
                str(CREDENTIALS_PATH), SCOPES
            )
            creds = flow.run_local_server(port=0)

        with open(TOKEN_PATH, "w") as token:
            token.write(creds.to_json())

    return build("drive", "v3", credentials=creds)


def find_folder(service, folder_name, parent_name="Hiking Content"):
    """Find a folder by name within the Hiking Content parent folder."""
    # First find the parent folder
    results = (
        service.files()
        .list(
            q=f"name='{parent_name}' and mimeType='application/vnd.google-apps.folder' and trashed=false",
            fields="files(id, name)",
        )
        .execute()
    )
    parent_folders = results.get("files", [])

    if not parent_folders:
        print(f"ERROR: Parent folder '{parent_name}' not found in Google Drive.")
        print(f"  Create a folder called '{parent_name}' in your Google Drive root.")
        sys.exit(1)

    parent_id = parent_folders[0]["id"]

    # Now find the hike folder within it
    results = (
        service.files()
        .list(
            q=f"name='{folder_name}' and '{parent_id}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false",
            fields="files(id, name)",
        )
        .execute()
    )
    folders = results.get("files", [])

    if not folders:
        print(f"ERROR: Folder '{folder_name}' not found in '{parent_name}'.")
        # List available folders
        results = (
            service.files()
            .list(
                q=f"'{parent_id}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false",
                fields="files(id, name)",
                orderBy="name",
            )
            .execute()
        )
        available = results.get("files", [])
        if available:
            print("  Available folders:")
            for f in available:
                print(f"    - {f['name']}")
        sys.exit(1)

    return folders[0]["id"]


def list_files_in_folder(service, folder_id):
    """List all files in a Drive folder (recursively includes subfolders)."""
    all_files = []
    page_token = None

    while True:
        results = (
            service.files()
            .list(
                q=f"'{folder_id}' in parents and trashed=false",
                fields="nextPageToken, files(id, name, mimeType, size)",
                pageToken=page_token,
            )
            .execute()
        )
        files = results.get("files", [])
        all_files.extend(files)

        page_token = results.get("nextPageToken")
        if not page_token:
            break

    return all_files


def download_file(service, file_id, file_name, output_dir):
    """Download a file from Google Drive."""
    output_path = output_dir / file_name
    if output_path.exists():
        print(f"  Skipping (exists): {file_name}")
        return

    request = service.files().get_media(fileId=file_id)
    fh = io.BytesIO()
    downloader = MediaIoBaseDownload(fh, request)

    done = False
    while not done:
        _, done = downloader.next_chunk()

    with open(output_path, "wb") as f:
        f.write(fh.getvalue())

    print(f"  Downloaded: {file_name}")


def sync_folder(service, folder_id, output_dir):
    """Download all files from a Drive folder to a local directory."""
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    files = list_files_in_folder(service, folder_id)

    if not files:
        print("  No files found in this folder.")
        return

    # Separate folders and files
    subfolders = [
        f for f in files if f["mimeType"] == "application/vnd.google-apps.folder"
    ]
    regular_files = [
        f for f in files if f["mimeType"] != "application/vnd.google-apps.folder"
    ]

    # Download regular files
    for f in regular_files:
        download_file(service, f["id"], f["name"], output_dir)

    # Recursively sync subfolders
    for sf in subfolders:
        sub_output = output_dir / sf["name"]
        print(f"\n  Entering subfolder: {sf['name']}/")
        sync_folder(service, sf["id"], sub_output)


def main():
    parser = argparse.ArgumentParser(
        description="Sync a Google Drive hiking folder to local disk"
    )
    parser.add_argument(
        "--folder-name",
        required=True,
        help="Name of the hike folder in Google Drive (e.g., '2026-02-15-sedona')",
    )
    parser.add_argument(
        "--output",
        required=True,
        help="Local directory to download files to",
    )
    parser.add_argument(
        "--parent-folder",
        default="Hiking Content",
        help="Name of the parent folder in Drive (default: 'Hiking Content')",
    )

    args = parser.parse_args()
    output_dir = Path(os.path.expanduser(args.output))

    print("Authenticating with Google Drive...")
    service = get_drive_service()

    print(f"Finding folder: {args.parent_folder}/{args.folder_name}")
    folder_id = find_folder(service, args.folder_name, args.parent_folder)

    print(f"Syncing to: {output_dir}")
    sync_folder(service, folder_id, output_dir)

    print(f"\nSync complete! Files saved to: {output_dir}")


if __name__ == "__main__":
    main()
