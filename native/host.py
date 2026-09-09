#!/usr/bin/env python3
"""Restricted Chrome native host for downloading X posts and LinkedIn video streams."""
import json
import os
from pathlib import Path
import queue
import re
import signal
import struct
import subprocess
import sys
import tempfile
import threading
import time
from urllib.parse import urlsplit
import uuid

MAX_MESSAGE = 8192
HOST_NAME = 'com.blob_video_downloader.ytdlp'


def canonical_tweet_url(value):
    if not isinstance(value, str) or len(value) > 2048:
        raise ValueError('Please choose a valid X post video.')
    url = urlsplit(value)
    if (url.scheme != 'https' or url.hostname not in ('x.com', 'www.x.com', 'twitter.com', 'www.twitter.com')
            or url.username or url.password or url.port not in (None, 443)):
        raise ValueError('Only HTTPS X post links are supported.')
    match = re.fullmatch(r'/(?:[A-Za-z0-9_]{1,15}|i/web)/status/(\d{1,25})(?:/video/([1-4]))?/?', url.path)
    if not match:
        raise ValueError('Please choose a video inside an X post.')
    return f'https://x.com/i/status/{match[1]}' + (f'/video/{match[2]}' if match[2] else '')


def canonical_download_url(value):
    if not isinstance(value, str) or len(value) > 7000:
        raise ValueError('Please choose a valid video.')
    url = urlsplit(value)
    if url.hostname in ('x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'):
        return canonical_tweet_url(value)
    if (url.scheme != 'https' or url.hostname not in ('media.licdn.com', 'dms.licdn.com')
            or url.username or url.password or url.port not in (None, 443)):
        raise ValueError('Only X posts and LinkedIn media links are supported.')
    playlist = re.match(r'/playlist/vid/(?:v2/)?[A-Za-z0-9_-]+/', url.path)
    video = re.match(r'/dms/video/(?:v2/)?[A-Za-z0-9_-]+/', url.path) and url.path.lower().endswith('.mp4')
    if (not (playlist or video) or re.search(r'\.(?:m4s|ts|aac|m4a)$', url.path, re.I)
            or (playlist and url.path.lower().endswith('.mp4'))):
        raise ValueError('Please choose a complete LinkedIn video, not a video fragment.')
    # LinkedIn media URLs are signed. Keep the query; never accept cookies,
    # custom request headers, output paths or arbitrary hosts from the website.
    return url._replace(fragment='').geturl()


def video_stem(url):
    url = canonical_download_url(url)
    if urlsplit(url).hostname in ('x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'):
        return 'X-' + url.split('/status/')[1].split('/')[0]
    asset = re.search(r'/(?:dms/video|playlist/vid)/(?:v2/)?([A-Za-z0-9_-]+)/', urlsplit(url).path)[1]
    return 'LinkedIn-' + asset[:100]


def read_exact(stream, count):
    result = bytearray()
    while len(result) < count:
        chunk = stream.read(count - len(result))
        if not chunk:
            if not result:
                return None
            raise ValueError('Incomplete native message.')
        result.extend(chunk)
    return bytes(result)


def read_message(stream):
    header = read_exact(stream, 4)
    if header is None:
        return None
    size = struct.unpack('=I', header)[0]
    if size < 2 or size > MAX_MESSAGE:
        raise ValueError('Invalid native message size.')
    payload = read_exact(stream, size)
    if payload is None:
        raise ValueError('Incomplete native message.')
    message = json.loads(payload)
    if not isinstance(message, dict):
        raise ValueError('Expected a JSON object.')
    return message


def build_command(config, url, output_dir, token):
    url = canonical_download_url(url)
    stem = video_stem(url)
    # No shell, website-selected filenames, cookies, user config, or plugins.
    # Prefer a complete MP4; merge separate MP4/audio streams when necessary.
    return [config['yt_dlp'], '--ignore-config', '--no-playlist',
            '--no-colors', '--newline', '--progress', '--socket-timeout', '30',
            '--retries', '3', '--fragment-retries', '3', '--no-overwrites',
            '--restrict-filenames', '--ffmpeg-location', config['ffmpeg'],
            '-f', 'b[ext=mp4]/bv[ext=mp4]+ba[ext=m4a]/b',
            '--merge-output-format', 'mp4', '--remux-video', 'mp4',
            '--progress-template', 'download:__BVD_PROGRESS__%(progress._percent_str)s',
            '--print', 'after_move:__BVD_FILE__%(filepath)s',
            '-o', str(output_dir).replace('%', '%%') + f'/{stem}-{token}.%(ext)s', '--', url]


def stop_process(process):
    if process.poll() is None:
        try:
            os.killpg(process.pid, signal.SIGTERM)
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
        except ProcessLookupError:
            pass


def choose_destination(config, url, cancelled):
    stem = video_stem(url)
    # Only the native Save dialog supplies this path. The extension and website
    # cannot provide filesystem paths or code for the dialog to execute.
    command = ['/usr/bin/osascript', '-l', 'JavaScript',
               str(Path(__file__).with_name('save_dialog.js')),
               f'{stem}.mp4', config['download_dir']]
    process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, text=True, start_new_session=True)
    try:
        while True:
            if cancelled.is_set():
                return None
            try:
                output, error = process.communicate(timeout=0.25)
                break
            except subprocess.TimeoutExpired:
                continue
        if process.returncode != 0:
            raise ValueError('The Save dialog could not open. Please try again.')
        result = json.loads(output)
        if result.get('cancelled'):
            return None
        destination = Path(result['path'])
        if not destination.is_absolute() or destination.suffix.lower() != '.mp4':
            raise ValueError('Please save the video with an .mp4 filename.')
        return destination.parent.resolve() / destination.name
    finally:
        stop_process(process)
        process.stdout.close()
        process.stderr.close()


def file_state(path):
    try:
        stat = path.lstat()
        return (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)
    except FileNotFoundError:
        return None


def publish_video(source, destination, selected_state):
    # Keep an existing file intact throughout download/merge, even if cancelled.
    # A replacement was confirmed in the native dialog. If the destination has
    # since changed, leave it alone instead of overwriting another download.
    if file_state(destination) != selected_state:
        raise ValueError('The chosen file changed while downloading. Please try again with a different filename.')
    os.replace(source, destination)


def download(config, url, send, cancelled):
    token = uuid.uuid4().hex[:12]
    process = None
    staging = None
    final_path = None
    try:
        send({'status': 'progress', 'message': 'Choose a filename and folder in the Save dialog…', 'percent': None})
        destination = choose_destination(config, url, cancelled)
        if destination is None or cancelled.is_set():
            send({'status': 'cancelled', 'message': 'Download cancelled.'})
            return
        selected_state = file_state(destination)
        # Stage on the destination filesystem so only a finished MP4 is moved to
        # the chosen name. Failed downloads never replace the user's old file.
        staging = tempfile.TemporaryDirectory(prefix='.blob-video-', dir=destination.parent)
        output_dir = Path(staging.name).resolve()
        command = build_command(config, url, output_dir, token)
        send({'status': 'progress', 'message': 'Finding the full video…', 'percent': None})
        with tempfile.TemporaryFile(mode='w+b') as error_log:
            # This environment switch also works with older yt-dlp releases
            # that do not recognize the newer --no-plugin-dirs option.
            environment = {**os.environ, 'YTDLP_NO_PLUGINS': '1'}
            process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                       stderr=error_log, text=True, start_new_session=True, env=environment)
            lines = queue.Queue()

            def read_output():
                for line in process.stdout:
                    lines.put(line.rstrip('\n'))
                lines.put(None)

            reader = threading.Thread(target=read_output, daemon=True)
            reader.start()
            start = time.monotonic()
            percent = None
            while True:
                if cancelled.is_set():
                    stop_process(process)
                    send({'status': 'cancelled', 'message': 'Download cancelled.'})
                    return
                if time.monotonic() - start > 1800:
                    raise TimeoutError('The download took too long. Please try again.')
                try:
                    line = lines.get(timeout=1)
                except queue.Empty:
                    continue
                if line is None:
                    break
                if line.startswith('__BVD_PROGRESS__'):
                    match = re.search(r'(\d+(?:\.\d+)?)%', line)
                    percent = min(100, float(match[1])) if match else None
                    send({'status': 'progress', 'message': 'Downloading…' if percent is None or percent < 100 else 'Finishing the MP4…', 'percent': percent})
                elif line.startswith('__BVD_FILE__'):
                    candidate = Path(line[len('__BVD_FILE__'):]).resolve()
                    # Never report or clean up a path outside this job's output.
                    if candidate.parent == output_dir and token in candidate.name:
                        final_path = candidate
            process.wait(timeout=10)
            if cancelled.is_set():
                send({'status': 'cancelled', 'message': 'Download cancelled.'})
                return
            if process.returncode != 0:
                error_log.seek(0)
                detail = error_log.read(16384).decode('utf-8', errors='replace').lower()
                if any(word in detail for word in ('login', 'logged in', 'private', 'protected', 'unavailable', 'not found')):
                    raise ValueError('This video is unavailable or its link has expired. Refresh the page and play it again. The helper does not read your browser cookies.')
                raise ValueError('The site could not provide a downloadable video. Please try again; yt-dlp may need an update.')
            if not final_path or not final_path.is_file() or final_path.stat().st_size == 0:
                raise ValueError('The downloader did not produce a complete video file.')
            publish_video(final_path, destination, selected_state)
            send({'status': 'complete', 'filename': destination.name})
    except (OSError, ValueError, subprocess.SubprocessError, TimeoutError) as error:
        send({'status': 'error', 'message': str(error)[:500]})
    finally:
        if process:
            stop_process(process)
            if process.stdout:
                process.stdout.close()
        if staging:
            staging.cleanup()


def run(config, input_stream, output_stream, origin):
    lock = threading.Lock()
    cancelled = threading.Event()
    worker = None

    def send(message):
        payload = json.dumps(message, ensure_ascii=False).encode('utf-8')
        try:
            with lock:
                output_stream.write(struct.pack('=I', len(payload)) + payload)
                output_stream.flush()
        except (BrokenPipeError, OSError):
            cancelled.set()

    if origin != f"chrome-extension://{config['extension_id']}/":
        send({'status': 'error', 'message': 'This extension is not authorized to use the helper.'})
        return
    try:
        while True:
            message = read_message(input_stream)
            if message is None:
                break
            action = message.get('action')
            if action == 'ping':
                send({'status': 'ready', 'version': 1})
            elif action == 'cancel':
                cancelled.set()
            elif action == 'download':
                if worker is not None:
                    raise ValueError('Only one download is allowed per connection.')
                url = canonical_download_url(message.get('url'))
                worker = threading.Thread(target=download, args=(config, url, send, cancelled))
                worker.start()
            else:
                raise ValueError('Unsupported helper action.')
    except (ValueError, UnicodeError, OSError) as error:
        send({'status': 'error', 'message': str(error)[:500]})
    finally:
        cancelled.set()
        if worker:
            worker.join(timeout=15)


if __name__ == '__main__':
    configuration = json.loads(Path(__file__).with_name('config.json').read_text())
    run(configuration, sys.stdin.buffer, sys.stdout.buffer, sys.argv[1] if len(sys.argv) > 1 else '')
