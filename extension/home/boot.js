// @ts-check
import { afterStaticShellPaint, startVaultShell } from '../sidepanel/vault-shell.js';

document.documentElement.dataset.peerdBootModule = 'evaluated';
afterStaticShellPaint(() => {
  startVaultShell({
    portName: 'home',
    // A genuinely fresh unlocked profile correctly enters the onboarding gate
    // before the navigation shell. Both are complete rich-app mount states.
    appSelector: '.home-shell, .options-gate',
    loadApplication: async () => {
      const app = await import('./home.js');
      return app.startHome;
    },
  });
});
