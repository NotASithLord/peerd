// @ts-check
// Fixture worker proving the SEAL-FIRST import ordering that notebook-tab.js
// relies on: the production seal module is declared before a "leaky"
// module whose TOP-LEVEL body reaches for raw network primitives —
// exactly the shape of an agent entry whose static import tries to
// exfiltrate at load time. Module graphs evaluate depth-first in
// declaration order, so the leak attempt must already find a sealed
// realm.

import '/notebook-tab/realm-seal.js';
import './seal-order-leaky.js';

postMessage({
  type: 'order-result',
  result: /** @type {{ __peerdSealOrderProbe: unknown }} */ (
    /** @type {unknown} */ (globalThis)
  ).__peerdSealOrderProbe,
});
