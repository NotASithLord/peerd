'use strict';
// @ts-check
// Classic-script extension page (no ES module sugar needed). Runs at
// chrome-extension://<id>/permissions/mic.html when the user clicks
// "Grant microphone access" from the side panel's settings.
//
// Why this page exists
// --------------------
// Chrome side panels and offscreen documents both struggle to surface
// the mic permission prompt reliably. The dedicated extension-tab
// pattern is the V1 MV3 workaround: open this page in a real tab
// (chrome.tabs.create), call getUserMedia in response to a click here,
// browser shows the standard prompt, user clicks Allow. The grant is
// scoped to the chrome-extension:// origin, so the side panel and
// offscreen inherit it for subsequent calls.
//
// This file is INTENTIONALLY a classic script — no module imports, no
// chrome-extension://-relative ESM resolution. The page is small and
// self-contained, which is the right shape for a single-purpose
// permission-grant surface.

(function micGrant() {
  const btn = document.getElementById('grant');
  const statusEl = document.getElementById('status');
  const helpEl = document.getElementById('platform-help');
  const stepsEl = document.getElementById('platform-steps');

  // ---- platform-specific help ---------------------------------------------
  const platformSteps = () => {
    const ua = navigator.userAgent;
    if (/Mac OS X|Macintosh/.test(ua)) {
      return [
        'Open System Settings → Privacy & Security → Microphone',
        'Make sure Google Chrome (or your browser) is enabled',
        'Reload this tab and click the button again',
      ];
    }
    if (/Windows/.test(ua)) {
      return [
        'Open Settings → Privacy & security → Microphone',
        'Microphone access must be ON',
        'Make sure Chrome is in the "Apps that can access your microphone" list',
        'Reload this tab and click the button again',
      ];
    }
    return [
      'Open your operating system\'s privacy settings',
      'Allow your browser to access the microphone',
      'Reload this tab and click the button again',
    ];
  };

  const showPlatformHelp = () => {
    if (!helpEl || !stepsEl) return;
    stepsEl.innerHTML = '';
    for (const step of platformSteps()) {
      const li = document.createElement('li');
      li.textContent = step;
      stepsEl.appendChild(li);
    }
    helpEl.classList.add('is-shown');
  };

  // ---- status helpers ------------------------------------------------------
  const setStatus = (text, kind /* 'ok' | 'err' */) => {
    statusEl.textContent = text;
    statusEl.className = `status is-${kind}`;
  };

  // ---- grant flow ----------------------------------------------------------
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    setStatus('Requesting microphone permission…', 'ok');
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      // The most common path. Cause is one of:
      //   - User clicked Block on the prompt
      //   - Permission was previously denied and the browser cached it
      //   - OS-level mic access for this browser is off
      btn.disabled = false;
      const name = e && e.name ? e.name : 'Error';
      const message = e && e.message ? e.message : String(e);
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        setStatus(
          'Permission was not granted. The browser may have blocked the '
          + 'request without prompting if it was denied previously, or if '
          + 'your operating system is blocking microphone access for the '
          + 'browser.',
          'err',
        );
      } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        setStatus(
          'No microphone was found. Connect a mic and reload this tab.',
          'err',
        );
      } else {
        setStatus(`Failed: ${name}: ${message}`, 'err');
      }
      showPlatformHelp();
      // why: notify the side panel even on failure so its state can
      // refresh. The side panel decides whether to clear or keep the
      // error string based on the result.
      try {
        chrome.runtime.sendMessage({
          type: 'voice/permission-result',
          ok: false,
          name,
          message,
        });
      } catch (_) { /* side panel may be closed; that's fine */ }
      return;
    }
    // Got the grant. Release the stream — we don't actually want to
    // capture audio here.
    try { stream.getTracks().forEach((t) => t.stop()); }
    catch (_) { /* harmless */ }
    setStatus(
      '✓ Microphone access granted. You can close this tab and click '
      + 'the mic in the peerd side panel.',
      'ok',
    );
    btn.style.display = 'none';
    try {
      chrome.runtime.sendMessage({ type: 'voice/permission-result', ok: true });
    } catch (_) { /* noop */ }
    // Auto-close shortly so the user doesn't have to. Some browsers
    // forbid window.close() on tabs not opened by the script; if so,
    // the success message + button-hidden state is the user's signal.
    setTimeout(() => {
      try { window.close(); }
      catch (_) { /* leave the tab open; user closes manually */ }
    }, 1200);
  });
})();
