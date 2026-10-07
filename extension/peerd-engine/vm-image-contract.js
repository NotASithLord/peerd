// @ts-check
// why: import/export custody needs the storage identity without acquiring the
// image-verification implementation used by the VM boot path.

/**
 * chrome.storage.local key for the per-URL TOFU fingerprints
 * ({ [url]: { totalBytes, headSha256, pinnedAt } }). Lives here (not in
 * vm-tab.js) because two shells read it: the vm-tab boot path verifies
 * against it, and the SW's artifact export/import routes carry the pin
 * inside vm-recipe envelopes (DESIGN-10).
 */
export const IMAGE_PIN_STORAGE_KEY = 'vmImagePins.v1';
