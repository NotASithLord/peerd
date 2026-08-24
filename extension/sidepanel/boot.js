// @ts-check
import { afterStaticShellPaint, startVaultShell } from './vault-shell.js';

document.documentElement.dataset.peerdBootModule = 'evaluated';
afterStaticShellPaint(() => {
  startVaultShell({
    portName: 'sidepanel',
    appSelector: '.app-shell',
    loadApplication: async () => {
      const app = await import('./sidepanel.js');
      return app.startSidepanel;
    },
  });
});
