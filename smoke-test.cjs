/**
 * Loads dist/vibes3d-studio.html in jsdom and checks that the page wires
 * itself up. jsdom has no WebGL, so three.js's renderer will fail — that is
 * expected and is exactly why initScene() runs last in main.js, after every
 * event listener is attached. This test proves the buttons still work even
 * when the 3D canvas can't initialise.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const file = path.join(__dirname, 'dist', 'vibes3d-studio.html');
const html = fs.readFileSync(file, 'utf8');

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { console.log('  PASS  ' + name); pass++; }
  else { console.log('  FAIL  ' + name + (extra ? '\n        ' + extra : '')); fail++; }
};

console.log('\nSingle-file build smoke test\n');

const errors = [];
const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  resources: undefined, // don't fetch the Google Fonts stylesheet
  virtualConsole: new (require('jsdom').VirtualConsole)()
    .on('jsdomError', (e) => errors.push(e.message))
    .on('error', (m) => errors.push(String(m))),
});

const { window } = dom;
const doc = window.document;

// Give the inline script a tick to execute.
setTimeout(() => {
  check('stylesheet is inlined (has <style> with our tokens)',
    /--accent:\s*#39ff6a/.test(html));

  check('no external script src remains',
    !/<script[^>]+src=/.test(html));

  const dz = doc.getElementById('dropzone');
  const uploadBtn = doc.getElementById('uploadBtn');
  const fileInput = doc.getElementById('fileInput');
  check('dropzone, upload button and file input all present',
    !!dz && !!uploadBtn && !!fileInput);

  // Clicking Upload should forward to the hidden file input.
  let fileInputClicked = false;
  if (fileInput) fileInput.addEventListener('click', () => { fileInputClicked = true; });
  if (uploadBtn) uploadBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  check('Upload button triggers the file picker', fileInputClicked,
    'listener did not fire — the script likely threw before attaching handlers');

  // The hamburger should toggle the drawer.
  const menuBtn = doc.getElementById('menuBtn');
  const drawer = doc.getElementById('drawer');
  if (menuBtn) menuBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  check('menu button opens the drawer',
    drawer && drawer.classList.contains('is-open'));

  // "How it works" opens the dialog.
  const howBtn = doc.getElementById('howBtn');
  const howDialog = doc.getElementById('howDialog');
  let dialogOpened = false;
  if (howDialog) howDialog.showModal = () => { dialogOpened = true; };
  if (howBtn) howBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  check('"How it works" opens the modal', dialogOpened);

  // Drag styling should apply on dragover.
  if (dz) {
    const ev = new window.Event('dragover', { bubbles: true, cancelable: true });
    dz.dispatchEvent(ev);
  }
  check('dropzone reacts to dragover',
    dz && dz.classList.contains('is-dragover'));

  const fatal = errors.filter((e) =>
    !/WebGL|getContext|Not implemented|canvas/i.test(e));
  check('no fatal script errors (WebGL/canvas warnings ignored)',
    fatal.length === 0, fatal.slice(0, 3).join(' | '));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}, 500);
