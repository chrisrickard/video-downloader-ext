// Run only by the native helper. Arguments are data, never evaluated as code.
ObjC.import('AppKit');
function run(argv) {
  const app = $.NSApplication.sharedApplication;
  app.setActivationPolicy(1);
  const panel = $.NSSavePanel.savePanel;
  panel.title = 'Save video';
  panel.prompt = 'Save';
  panel.nameFieldStringValue = argv[0];
  panel.directoryURL = $.NSURL.fileURLWithPath(argv[1]);
  panel.allowedFileTypes = ['mp4'];
  panel.allowsOtherFileTypes = false;
  panel.canCreateDirectories = true;
  panel.extensionHidden = false;
  app.activateIgnoringOtherApps(true);
  // NSSavePanel confirms replacement of existing files before returning OK.
  if (panel.runModal !== $.NSModalResponseOK) return JSON.stringify({ cancelled: true });
  return JSON.stringify({ path: ObjC.unwrap(panel.URL.path) });
}
