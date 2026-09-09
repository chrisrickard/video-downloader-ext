#!/usr/bin/env python3
"""Install an isolated, current yt-dlp runtime for YouTube downloads on macOS."""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import venv


def install():
    if sys.platform != 'darwin':
        raise SystemExit('This helper installer supports macOS.')
    folder = Path.home() / 'Library/Application Support/Blob Video Downloader'
    config_path = folder / 'config.json'
    if not config_path.exists():
        raise SystemExit('Run install_macos.py with your extension ID first.')
    node = shutil.which('node')
    if not node or int(subprocess.check_output([node, '--version'], text=True).strip().lstrip('v').split('.')[0]) < 22:
        raise SystemExit('YouTube requires Node.js 22 or newer on PATH.')
    runtime = folder / 'youtube-runtime'
    venv.EnvBuilder(with_pip=True).create(runtime)
    # Use the published package and its matching EJS dependency. Keep this
    # separate from the existing downloader used by X and LinkedIn.
    subprocess.run([str(runtime / 'bin/python'), '-m', 'pip', 'install', '--upgrade',
                    '--only-binary=:all:', 'yt-dlp[default]'], check=True)
    config = json.loads(config_path.read_text())
    config.update(youtube_yt_dlp=str(runtime / 'bin/yt-dlp'), youtube_node=node)
    config_path.write_text(json.dumps(config, indent=2) + '\n')
    config_path.chmod(0o600)
    print('YouTube runtime installed. Reload the extension and refresh YouTube.')


if __name__ == '__main__':
    install()
