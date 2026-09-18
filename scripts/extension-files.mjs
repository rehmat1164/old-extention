import { readdir } from 'node:fs/promises';

export async function extensionFiles() {
  const files = [
    'manifest.json', 'background.js', 'sidepanel.html', 'offscreen.html',
    'LICENSE.md', 'INSTALL.md', 'css/panel.css',
    'images/icon16.png', 'images/icon48.png', 'images/logo.png',
    'js/bridge.js', 'js/panel.js', 'js/downloads-view.js', 'js/offscreen.js', 'js/content.js',
  ];
  for (const directory of ['js/lib', 'js/automation']) {
    for (const file of await readdir(directory, { withFileTypes: true })) {
      if (file.isFile() && file.name.endsWith('.js')) files.push(`${directory}/${file.name}`);
    }
  }
  return files.sort();
}
