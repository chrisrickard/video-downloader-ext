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
            host.download({'yt_dlp': str(fake), 'ffmpeg': '/unused', 'download_dir': str(folder)},
                          'https://x.com/u/status/123', send, cancelled)
            self.assertEqual(messages[-1]['status'], 'cancelled')
            self.assertFalse(list(folder.glob('X-*')))


if __name__ == '__main__':
    unittest.main()
