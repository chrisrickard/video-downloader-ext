import importlib.util
import io
import json
from pathlib import Path
import struct
import tempfile
import threading
import sys
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('native_host', Path(__file__).parents[1] / 'native/host.py')
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)


class NativeTests(unittest.TestCase):
    def test_canonical_url(self):
        self.assertEqual(host.canonical_tweet_url('https://twitter.com/example/status/123/video/2?s=46'), 'https://x.com/i/status/123/video/2')
        self.assertEqual(host.canonical_tweet_url('https://x.com/i/web/status/123'), 'https://x.com/i/status/123')

    def test_reject_unsafe_inputs(self):
        for value in [None, {}, 'file:///etc/passwd', 'https://x.com.evil.test/u/status/123',
                      'http://x.com/u/status/123', 'https://x.com:8443/u/status/123',
                      'https://user@x.com/u/status/123', '--exec=anything',
                      'https://x.com/u/status/123/video/9', 'https://x.com/home',
                      'https://x.com/u/status/123/../../home']:
            with self.subTest(value=value), self.assertRaises((ValueError, TypeError)):
                host.canonical_tweet_url(value)

    def test_protocol_and_limits(self):
        payload = json.dumps({'action': 'ping', 'text': '日本語'}).encode()
        wire = struct.pack('=I', len(payload)) + payload
        self.assertEqual(host.read_message(io.BytesIO(wire))['text'], '日本語')
        for wire in [b'xx', struct.pack('=I', 9000), struct.pack('=I', 10) + b'{}', struct.pack('=I', 2) + b'[]']:
            with self.subTest(wire=wire), self.assertRaises(ValueError):
                host.read_message(io.BytesIO(wire))

    def test_other_extension_cannot_connect(self):
        out = io.BytesIO()
        host.run({'extension_id': 'a' * 32}, io.BytesIO(), out, 'chrome-extension://' + 'b' * 32 + '/')
        out.seek(0)
        self.assertEqual(host.read_message(out)['status'], 'error')

    def test_bad_url_never_starts_process(self):
        data = json.dumps({'action': 'download', 'url': 'https://evil.test/a'}).encode()
        out = io.BytesIO()
        with patch.object(host.subprocess, 'Popen') as spawn:
            host.run({'extension_id': 'a' * 32}, io.BytesIO(struct.pack('=I', len(data)) + data), out, 'chrome-extension://' + 'a' * 32 + '/')
            spawn.assert_not_called()
        out.seek(0)
        self.assertEqual(host.read_message(out)['status'], 'error')

    def test_fixed_command_and_output(self):
        command = host.build_command({'yt_dlp': '/tools/yt-dlp', 'ffmpeg': '/tools/ffmpeg'},
                                     'https://x.com/example/status/123?s=46', Path('/downloads'), 'abc')
        self.assertEqual(command[-2:], ['--', 'https://x.com/i/status/123'])
        self.assertIn('--ignore-config', command)
        self.assertNotIn('--no-plugin-dirs', command)  # Compatibility with yt-dlp 2025.02.19.
        self.assertIn('/downloads/X-123-abc.%(ext)s', command)
        self.assertNotIn('--cookies-from-browser', command)
        command = host.build_command({'yt_dlp': '/tools/yt-dlp', 'ffmpeg': '/tools/ffmpeg'},
                                     'https://x.com/u/status/123', Path('/my 100% videos'), 'abc')
        self.assertIn('/my 100%% videos/X-123-abc.%(ext)s', command)

    def test_cancel_stops_process_and_cleans_its_partial_file(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            fake = folder / 'fake-downloader'
            fake.write_text('#!' + sys.executable + '\n'
                            'import os, sys, time\nfrom pathlib import Path\n'
                            'assert os.environ["YTDLP_NO_PLUGINS"] == "1"\n'
                            'output = sys.argv[sys.argv.index("-o") + 1].replace("%(ext)s", "mp4.part")\n'
                            'Path(output).write_text("partial")\n'
                            'print("__BVD_PROGRESS__50%", flush=True)\n'
                            'time.sleep(60)\n')
            fake.chmod(0o700)
            cancelled = threading.Event()
            messages = []
            def send(message):
                messages.append(message)
                if message.get('percent') == 50:
                    cancelled.set()
            destination = folder / 'My chosen filename.mp4'
            destination.write_text('keep this existing video')
            with patch.object(host, 'choose_destination', return_value=destination):
                host.download({'yt_dlp': str(fake), 'ffmpeg': '/unused', 'download_dir': str(folder)},
                              'https://x.com/u/status/123', send, cancelled)
            self.assertEqual(destination.read_text(), 'keep this existing video')
            self.assertFalse(list(folder.glob('.blob-video-*')))
            self.assertEqual(messages[-1]['status'], 'cancelled')
            self.assertFalse(list(folder.glob('X-*')))

    def test_cancel_save_dialog_never_starts_download(self):
        messages = []
        with patch.object(host, 'choose_destination', return_value=None), patch.object(host.subprocess, 'Popen') as spawn:
            host.download({}, 'https://x.com/u/status/123', messages.append, threading.Event())
            spawn.assert_not_called()
        self.assertEqual(messages[-1]['status'], 'cancelled')

    def test_save_chosen_name_and_replace_only_completed_video(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            source = folder / 'staging.mp4'
            destination = folder / 'My trailer 日本語.mp4'
            source.write_bytes(b'complete new video')
            host.publish_video(source, destination, None)
            self.assertEqual(destination.read_bytes(), b'complete new video')
            source.write_bytes(b'updated complete video')
            selected = host.file_state(destination)
            host.publish_video(source, destination, selected)
            self.assertEqual(destination.read_bytes(), b'updated complete video')
            source.write_bytes(b'other video')
            with self.assertRaises(ValueError):
                host.publish_video(source, destination, selected)
            self.assertEqual(destination.read_bytes(), b'updated complete video')

    def test_success_uses_dialog_folder_and_filename(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            fake = folder / 'fake-downloader'
            fake.write_text('#!' + sys.executable + '\n'
                            'import sys\nfrom pathlib import Path\n'
                            'output = sys.argv[sys.argv.index("-o") + 1].replace("%(ext)s", "mp4")\n'
                            'Path(output).write_bytes(b"complete video")\n'
                            'print("__BVD_FILE__" + output, flush=True)\n')
            fake.chmod(0o700)
            destination = folder / 'My own filename.mp4'
            messages = []
            with patch.object(host, 'choose_destination', return_value=destination):
                host.download({'yt_dlp': str(fake), 'ffmpeg': '/unused'},
                              'https://x.com/u/status/123', messages.append, threading.Event())
            self.assertEqual(destination.read_bytes(), b'complete video')
            self.assertEqual(messages[-1], {'status': 'complete', 'filename': destination.name})
            self.assertFalse(list(folder.glob('.blob-video-*')))

    def test_linkedin_signed_stream_validation_and_filename(self):
        url = 'https://dms.licdn.com/playlist/vid/v2/D5605AQtest/mp4-cmaf/B56abc/0/1788892102?e=123&t=signed'
        self.assertEqual(host.canonical_download_url(url), url)
        self.assertEqual(host.video_stem(url), 'LinkedIn-D5605AQtest')
        command = host.build_command({'yt_dlp': '/tools/yt-dlp', 'ffmpeg': '/tools/ffmpeg'}, url, Path('/videos'), 'abc')
        self.assertEqual(command[-1], url)
        self.assertIn('/videos/LinkedIn-D5605AQtest-abc.%(ext)s', command)
        for invalid in ['https://dms.licdn.com.evil.test/playlist/vid/v2/ID/master.m3u8',
                        'https://user@dms.licdn.com/playlist/vid/v2/ID/master.m3u8',
                        'https://media.licdn.com/dms/image/v2/ID/image.jpg',
                        'https://dms.licdn.com/playlist/vid/v2/ID/segment.m4s',
                        'https://dms.licdn.com/playlist/vid/v2/ID/segment.mp4',
                        'file:///etc/passwd']:
            with self.subTest(url=invalid), self.assertRaises(ValueError):
                host.canonical_download_url(invalid)


if __name__ == '__main__':
    unittest.main()
