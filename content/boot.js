// Classic content script injected by the SW. Content scripts can't be ES modules, so this loads content/main.js with
// a dynamic import (main.js and its imports are listed in web_accessible_resources). The nonce makes a re-injection
// after an extension reload load fresh modules, and skips loading twice into the same page.
// The completion value (a promise) is what chrome.scripting.executeScript resolves with.
(globalThis.__zv3 && globalThis.__zv3.instance === globalThis.__zv3_boot_nonce)
  ? true
  : import(chrome.runtime.getURL('content/main.js') + '?i=' + encodeURIComponent(globalThis.__zv3_boot_nonce))
      .then(() => true, e => 'ZV3 Reader failed to load: ' + e);
