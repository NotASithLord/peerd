// Deliberately never yields after acknowledging the conversion request. The
// host must remain able to process Stop by terminating this disposable realm.
self.onmessage = () => {
  self.postMessage({ type: 'test/document-conversion-started' });
  while (true) { /* intentional CPU saturation */ }
};
