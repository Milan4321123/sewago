let installPrompt = null;

const installBtn = document.getElementById('install-btn');
const note = document.getElementById('install-note');
const url = document.getElementById('app-url');

const nativeCard = document.getElementById('native-card');
const nativeBtn = document.getElementById('native-btn');
const nativeNote = document.getElementById('native-note');
const pwaTitle = document.getElementById('pwa-title');

const ua = navigator.userAgent || '';
const isAndroid = /Android/i.test(ua);
const isIOS = /iPhone|iPad|iPod/i.test(ua) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

url.textContent = window.location.origin + '/download';

// Ask the server whether a real installable app (APK / App Store) exists.
async function loadAppInfo() {
  try {
    const res = await fetch('/api/app-info');
    if (!res.ok) return;
    const info = await res.json();

    if (isAndroid && info.androidApkUrl) {
      showNative(info.androidApkUrl, 'Download the SewaGo app (Android)',
        'Tap to download the .apk, then open it to install. If Android warns about "unknown sources", allow it for your browser once.');
    } else if (isIOS && info.iosAppStoreUrl) {
      showNative(info.iosAppStoreUrl, 'Get SewaGo on the App Store', '');
    }
  } catch (_) {
    // Offline or no endpoint — the PWA install card stays as the fallback.
  }
}

function showNative(href, label, hint) {
  nativeBtn.href = href;
  nativeBtn.textContent = label;
  nativeNote.textContent = hint;
  nativeCard.classList.remove('hidden');
  // Native app is the primary option; demote the web-app card.
  pwaTitle.textContent = 'Or use the web app instead';
}

// iPhone has no install prompt — guide the user to Safari's Share menu.
note.textContent = isIOS
  ? 'On iPhone: tap the Share icon in Safari, then "Add to Home Screen".'
  : 'Tap Install to add SewaGo to this phone.';

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  installPrompt = event;
  installBtn.disabled = false;
  note.textContent = 'Tap Install to add SewaGo to this phone.';
});

installBtn.addEventListener('click', async () => {
  if (!installPrompt) {
    note.textContent = isIOS
      ? 'On iPhone, use Safari Share, then Add to Home Screen.'
      : 'If no install prompt appears, use your browser menu and choose Add to Home Screen / Install app.';
    return;
  }
  installPrompt.prompt();
  await installPrompt.userChoice.catch(() => null);
  installPrompt = null;
});

window.addEventListener('appinstalled', () => {
  note.textContent = 'SewaGo is installed.';
});

loadAppInfo();
