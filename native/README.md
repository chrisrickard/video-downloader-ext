# Right-click downloads on X (macOS + Chrome)

Right-click a video in an X post and select **Download this video**. A small
progress panel appears at the bottom-right of the page, and a macOS Save dialog
lets you choose a filename and folder before downloading. Downloads is the
default folder. The panel disappears 3.5 seconds after completion. Errors stay visible until dismissed. No new tab opens.

Use **Cancel download** to stop it. Dismissing the panel or navigating away keeps
the download running; keep Chrome open until it finishes. Refreshing X restores
the panel for downloads that are still active in that tab.

The menu also works on a post's timestamp link. On timelines and replies it
uses the post you clicked, rather than the current tab's main post. For posts
with several rendered video players it requests the clicked video's index.
If X changes its page structure, the extension may need an update.

## One-time setup

1. Install `yt-dlp` and `ffmpeg` if they are not already available. Homebrew users
   can run `brew install yt-dlp ffmpeg`.
2. Load this extension directory through **Load unpacked** at
   `chrome://extensions`. Copy its 32-letter extension ID.
3. From the repository directory, run:

   ```sh
   python3 native/install_macos.py YOUR_EXTENSION_ID
   ```

4. Reload the extension at `chrome://extensions` and accept Chrome's updated
   permission prompt if shown. Refresh any X tabs that were already open.

The added permissions are `contextMenus` (the right-click item) and
`nativeMessaging` (the local downloader). The installer registers only the
extension ID you supply. It does not install an extension or change Chrome's
extension settings itself.

## What the helper does

- Chrome launches the helper on demand; no server or listening network port runs.
- Only HTTPS X/Twitter post URLs are accepted, and tracking queries are removed.
- The helper executes a fixed yt-dlp argument list without a shell. It ignores
  yt-dlp configuration and disables plugins. Websites cannot choose commands,
  arguments, or output directories.
- Complete MP4 formats are preferred. If necessary, yt-dlp and ffmpeg combine
  separate video/audio tracks into an MP4.
- Browser cookies are not read or exported. Protected or login-only posts may
  fail with an explanatory error.
- The native Save dialog supplies the filename and folder; websites cannot
  choose them. It confirms replacement of existing files. Downloads are staged
  privately and moved into place only after completion, so cancellation or failure
  preserves any existing destination file. At most two downloads run concurrently per extension.

The helper and pinned executable paths are stored in
`~/Library/Application Support/Blob Video Downloader/`. Its Chrome registration
is `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.blob_video_downloader.ytdlp.json`.
After upgrading Python or changing your tool installation paths, rerun the
installer with the same extension ID. Also rerun it after updating files in `native/`. Update yt-dlp if X changes its API.

To uninstall the helper, remove that registration file and the helper directory.
Downloaded videos are kept. Removing the extension in Chrome stops its menu and
its access to the helper.

## Checks

Run the dependency-free automated tests from the repository directory:

```sh
python3 -m unittest discover -s tests -p 'test_*.py'
node --test tests/extension.test.cjs
```

For a live check, reload the extension and refresh X, right-click a public post's
video, and confirm the result has both picture and sound. Also check a reply and
a post with multiple videos. Chrome's native-menu integration requires a real
browser check in addition to the automated message/URL tests.
