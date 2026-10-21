import { expect, test } from 'bun:test';
import { makeOptionsApp } from '../../extension/options/components/options-app-core.js';
import m from '../../extension/vendor/mithril/mithril.js';

test('actual Settings shell isolates keyed transfer instances across starter query changes', () => {
  const originalParam = m.route.param;
  try {
    for (const starter of [undefined, 'csv-lab', 'wasm-image', undefined]) {
      m.route.param = () => starter;
      const shell = makeOptionsApp().view({ attrs: {
        state: {vault:{initialized:true,locked:false}}, section:'transfer', send:async () => ({ok:true}),
      }, state:{} });
      const page = (shell.children as any[])[1].children[0];
      expect(page.children.every((child: any) => child.key == null)).toBe(true);
      const transfer = page.children[2].children[0];
      expect(transfer.key).toBe(starter ?? 'transfer');
      expect(transfer.attrs.starter).toBe(starter);
    }
  } finally { m.route.param = originalParam; }
});
