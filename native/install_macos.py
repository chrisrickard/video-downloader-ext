#!/usr/bin/env python3
"""Register the helper for one Chrome extension in the current macOS account."""
import argparse
import json
from pathlib import Path
import re
import shlex
import shutil
import sys

HOST_NAME = 'com.blob_video_downloader.ytdlp'


def install(extension_id):
    if sys.platform != 'darwin':
        raise SystemExit('This installer currently supports macOS and Google Chrome.')
    if not re.fullmatch('[a-p]{32}', extension_id):
        raise SystemExit('Enter the 32-letter extension ID from chrome://extensions.')
    ytdlp = shutil.which('yt-dlp')
    ffmpeg = shutil.which('ffmpeg')
    if not ytdlp or not ffmpeg:
        raise SystemExit('Install yt-dlp and ffmpeg before running this installer.')
    folder = Path.home() / 'Library/Application Support/Blob Video Downloader'
    manifests = Path.home() / 'Library/Application Support/Google/Chrome/NativeMessagingHosts'
    manifest_path = manifests / f'{HOST_NAME}.json'
    allowed_origin = f'chrome-extension://{extension_id}/'
    # Do not replace a registration belonging to a different extension.
    if manifest_path.exists():
        old = json.loads(manifest_path.read_text())
        if old.get('allowed_origins') != [allowed_origin]:
            raise SystemExit('A helper is registered to a different extension. Remove that registration before changing IDs.')
    folder.mkdir(parents=True, exist_ok=True)
    manifests.mkdir(parents=True, exist_ok=True)
    for name in ('host.py', 'save_dialog.js'):
        shutil.copy2(Path(__file__).with_name(name), folder / name)
    old_config = json.loads((folder / 'config.json').read_text()) if (folder / 'config.json').exists() else {}
    config = {**{key: old_config[key] for key in ('youtube_yt_dlp', 'youtube_node') if key in old_config}, 'extension_id': extension_id, 'yt_dlp': ytdlp, 'ffmpeg': ffmpeg,
              'download_dir': str(Path.home() / 'Downloads')}
    (folder / 'config.json').write_text(json.dumps(config, indent=2) + '\n')
    launcher = folder / 'launch.sh'
    # Chrome does not inherit the Terminal PATH. Pin Python and the helper path,
    # and supply standard tool locations for yt-dlp's subprocesses.
    launcher.write_text('#!/bin/sh\nexport PATH=/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin\nexec '
                        + shlex.quote(sys.executable) + ' ' + shlex.quote(str(folder / 'host.py')) + ' "$@"\n')
    launcher.chmod(0o700)
    (folder / 'config.json').chmod(0o600)
    manifest = {'name': HOST_NAME, 'description': 'Download X, LinkedIn and YouTube videos with yt-dlp',
                'path': str(launcher), 'type': 'stdio', 'allowed_origins': [allowed_origin]}
    manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
    print(f'Helper installed for extension {extension_id}.')
    print(f'Save dialog default folder: {config["download_dir"]}')
    print('Reload the extension in Chrome, then refresh your video tabs.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('extension_id')
    install(parser.parse_args().extension_id)
