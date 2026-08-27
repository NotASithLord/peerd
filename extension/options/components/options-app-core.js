// @ts-check
// Options shell — grouped sidebar nav + the active section page.
//
// A pure projection of attrs { state, send, section }: the router in
// options.js resolves the hash to a section id and passes it in. Nav
// entries are plain `#!/…` anchors, NOT m.route.set calls — Mithril's
// hash router picks the change up via hashchange, and the component
// never needs an active router. That is also what lets component tests
// mount this shell directly (the same constraint that forced logs-view
// into a try/catch around m.route.param, solved structurally here).
//
// Brand rule: monochrome shell; the wordmark in the nav rail (and on
// the gate) is the only color carrier. Error red stays the lone
// semantic exception.

import m from '/vendor/mithril/mithril.js';
import { CHANNEL, DWEB_ENABLED } from '/shared/channel-config.js';
import { openHome } from '/shared/open-home.js';
// Reused-in-place management surfaces (sidepanel/ is chassis, not a
// peerd-* module, so no import boundary applies).
import { SkillsView } from '/sidepanel/components/skills-view.js';
import { HooksView } from '/sidepanel/components/hooks-view.js';
import { DenylistView } from '/sidepanel/components/denylist-view.js';
import { LearnedOriginsView } from '/sidepanel/components/learned-origins-view.js';
import { ActorIsolationBanner } from '/sidepanel/components/actor-isolation-banner.js';
import { ProvidersSection } from '../sections/providers.js';
import { BehaviorSection } from '../sections/behavior.js';
import { VoiceSection } from '../sections/voice.js';
import { VaultSection } from '../sections/vault.js';
import { ApiIntegrationsSection } from '../sections/api-integrations.js';
import { CostsSection } from '../sections/costs.js';
import { TransferSection } from '../sections/transfer.js';
import { MemoryView } from '../sections/memory.js';
import { ActivityView } from '../sections/activity.js';
import { DwebSection } from '../sections/dweb.js';
/** Build the Options shell with the exact target-owned optional section. */
export const makeOptionsApp = (
  /** @type {any|null} */ ContributorMetricsSection = null,
) => {
const CONTRIBUTOR_METRICS_ENABLED = ContributorMetricsSection !== null;

// The IA: three permanent groups + preview-scoped additions. Both gates are
// build-time literals, so store artifacts structurally omit unavailable nav.
/** @type {{ label: string, items: [string, string][] }[]} */
const NAV = [
  {
    label: 'Agent',
    items: [
      ['providers', 'Providers & models'],
      ['behavior', 'Behavior'],
      ['voice', 'Voice & OCR'],
      ['skills', 'Skills'],
      ['hooks', 'Hooks'],
    ],
  },
  {
    label: 'Data & memory',
    items: [
      ['memory', 'Memory'],
      ['costs', 'Costs'],
      ['transfer', 'Backup & restore'],
      ...(CONTRIBUTOR_METRICS_ENABLED
        ? /** @type {[string, string][]} */ ([['contributor-metrics', 'Contributor metrics']])
        : []),
    ],
  },
  {
    label: 'Security',
    items: [
      ['vault', 'Vault & unlock'],
      ['api-integrations', 'API integrations'],
      ['denylist', 'Denylist'],
      // Its own entry rather than a block under Denylist: that page is ~164
      // seed patterns tall, so anything appended to it sits below the fold -
      // and an un-learn control nobody can find is the problem this fixes.
      ['learned-sites', 'Learned sites'],
      ['activity', 'Activity'],
    ],
  },
  ...(DWEB_ENABLED
    ? [{ label: 'Preview', items: /** @type {[string, string][]} */ ([['dweb', 'Decentralized web']]) }]
    : []),
];

const SECTION_TITLES = Object.fromEntries(NAV.flatMap((g) => g.items));

// Five-block wordmark — same construction as the panel TopBar's. It plays the
// type→colorize render-in every time this tab becomes visible: the first open
// AND each time you switch back to it (the "swapback" that mirrors the panel
// hiding its mark while options is foregrounded).
//
// Why a visibilitychange listener + reflow rather than Mithril state/redraw: a
// plain tab switch doesn't reload this page, and a hidden (background) tab is
// throttled — rAF is paused, so a redraw-driven replay never fires while
// hidden and the away→back transition is missed. So we restart the CSS
// animation directly: toggle the class off, force a reflow, toggle it back on.
// The intro CSS lives in the panel's styles.css, which this page links first.
// Local copy on purpose (importing app.js would drag the whole panel view
// graph in).
const Wordmark = () => {
  /** @type {HTMLElement | null} */
  let el = null;
  const replay = () => {
    if (document.hidden || !el) return;
    el.classList.remove('wordmark--intro');
    void el.offsetWidth;                       // reflow so re-adding restarts it
    el.classList.add('wordmark--intro');
    // re-fade the adjacent preview badge in step with the logo
    const badge = /** @type {HTMLElement | null} */ (el.parentElement?.querySelector('.channel-badge') ?? null);
    if (badge) {
      badge.classList.remove('channel-badge--in');
      void badge.offsetWidth;
      badge.classList.add('channel-badge--in');
    }
  };
  return {
    oncreate: (/** @type {{ dom: HTMLElement }} */ v) => { el = v.dom; document.addEventListener('visibilitychange', replay); },
    onremove: () => document.removeEventListener('visibilitychange', replay),
    view: () => m('.wordmark.wordmark--intro', {
      'aria-label': 'peerd — back to home', role: 'link', tabindex: '0',
      title: 'Back to peerd home', style: 'cursor: pointer',
      onclick: () => openHome(),
      onkeydown: (/** @type {KeyboardEvent} */ e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openHome(); } },
    }, [
      m('.block.b-p', 'p'),
      m('.block.b-e', 'e'),
      m('.block.b-e2', 'e'),
      m('.block.b-r', 'r'),
      m('.block.b-d', 'd'),
      m('.wordmark-cursor', { 'aria-hidden': 'true' }),
    ]),
  };
};

/**
 * @param {string | null} heading
 * @param {string} copy
 */
const gate = (heading, copy) => m('.options-gate', m('.options-gate-card', [
  m(Wordmark),
  heading ? m('h2', heading) : null,
  m('p', copy),
]));

/** @typedef {import('../sections/reset-row.js').Send} Send */

const OptionsApp = {
  /** @param {{ state: any, attrs: { state: any, send: Send } }} vnode */
  oninit(vnode) {
    // Pending auto-memory suggestions count — feeds the badge on the
    // Memory nav entry (the discoverability affordance that used to be
    // the Context view's Memory-tab badge). Fed by the same
    // memory/suggestions route the Memory page itself uses.
    vnode.state.suggestionsCount = null;
    OptionsApp.refreshSuggestions(vnode);
  },

  /** @param {{ state: any, attrs: { state: any, send: Send } }} vnode */
  oncreate(vnode) {
    // why: approvals can also happen in-panel (or in another options
    // tab); re-pull the badge when the user comes back to this tab so
    // it doesn't advertise stale suggestions.
    vnode.state.onFocus = () => OptionsApp.refreshSuggestions(vnode);
    window.addEventListener('focus', vnode.state.onFocus);
  },

  /** @param {{state:any,attrs:{state:any,send:Send}}} vnode @param {{attrs:{state:any}}} old */
  onbeforeupdate(vnode, old) {
    if (!old.attrs.state && vnode.attrs.state) OptionsApp.refreshSuggestions(vnode);
    return true;
  },

  /** @param {{ state: any }} vnode */
  onremove(vnode) {
    window.removeEventListener('focus', vnode.state.onFocus);
  },

  /** @param {{ state: any, attrs: { state: any, send: Send } }} vnode */
  refreshSuggestions(vnode) {
    if (!vnode.attrs.state) return;
    vnode.attrs.send({ type: 'memory/suggestions' }).then((/** @type {any} */ r) => {
      vnode.state.suggestionsCount = r?.ok ? (r.suggestions?.length ?? 0) : 0;
      m.redraw();
    }).catch(() => {
      vnode.state.suggestionsCount = 0;
      m.redraw();
    });
  },

  /** @param {{ state: any, attrs: { state: any, send: Send, section: string,
   * stateLoadFailed?: boolean, retryState?:()=>unknown } }} vnode */
  view(vnode) {
    const { state, send, section } = vnode.attrs;
    const ui = vnode.state;

    // Gate ladder. The page is reachable from chrome://extensions before
    // any vault exists, and unlock is a panel-only ceremony — this page
    // never renders unlock UI, it points at the panel and re-reads state
    // on focus. ("the peerd panel", not "side panel": Firefox renders a
    // sidebar, and the phrase covers both.)
    if (!state) {
      if (vnode.attrs.stateLoadFailed) {
        return m('.options-gate', m('.options-gate-card', [
          m(Wordmark),
          m('h2', 'Peerd is restarting'),
          m('p', 'Peerd did not finish starting this page.'),
          m('button', {
            type: 'button',
            onclick: () => vnode.attrs.retryState?.(),
          }, 'Retry'),
        ]));
      }
      return gate(null, 'Loading…');
    }
    if (!state.vault?.initialized) {
      return gate('Set up peerd first',
        'There’s no vault yet. Open the peerd panel from the extension '
        + 'icon to set up peerd — this page picks the new state up when '
        + 'you return.');
    }
    if (state.vault.locked) {
      return gate('Vault locked',
        'Unlock peerd in the peerd panel, then come back — this page '
        + 'refreshes when it regains focus.');
    }

    const count = ui.suggestionsCount ?? 0;
    /** @param {[string, string]} entry */
    const navItem = ([id, label]) => m('a.options-nav-item', {
      href: `#!/${id}`,
      class: section === id ? 'is-active' : '',
      // why aria-current: the class alone marks the active entry visually;
      // a screen reader needs the programmatic current-page state.
      'aria-current': section === id ? 'page' : undefined,
    }, [
      label,
      // Memory carries the pending-suggestions badge so proposals are
      // discoverable from anywhere on this page.
      (id === 'memory' && count > 0)
        ? m('span.mem-badge', {
            title: `${count} suggested note${count === 1 ? '' : 's'} awaiting review`,
          }, count)
        : null,
    ]);

    return m('.options-shell', [
      m('nav.options-nav', { 'aria-label': 'Settings sections' }, [
        m(Wordmark),
        CHANNEL === 'preview'
          ? m('span.channel-badge.channel-badge--in', { title: 'peerd preview — dweb preview package' }, 'preview')
          : null,
        NAV.flatMap((group) => [
          m('.options-nav-group', group.label),
          ...group.items.map(navItem),
        ]),
      ]),
      m('main.options-content', m('.options-page', [
        m('h2', SECTION_TITLES[section] ?? 'Settings'),
        m(ActorIsolationBanner, { capability: state.capabilities?.actorExecution, send }),
        OptionsApp.section(vnode),
      ])),
    ]);
  },

  /** @param {{ attrs: { state: any, send: Send, section: string }, state: any }} vnode */
  section(vnode) {
    const { state, send, section } = vnode.attrs;
    switch (section) {
      case 'providers': return m(ProvidersSection, { state, send });
      case 'behavior':  return m(BehaviorSection, { state, send });
      case 'voice':     return m(VoiceSection, { state, send });
      // Self-fetching management surfaces, reused verbatim from the
      // panel's component set — they consume only {send} (+ state).
      case 'skills':    return m(SkillsView, { state, send });
      case 'hooks':     return m(HooksView, { send });
      case 'memory':    return m(MemoryView, {
        state,
        send,
        // Keep the nav badge honest after approve/dismiss.
        onSuggestionsChanged: () => OptionsApp.refreshSuggestions(vnode),
      });
      case 'costs':     return m(CostsSection, { state, send });
      case 'transfer':  return m(TransferSection, { send });
      case 'contributor-metrics': return CONTRIBUTOR_METRICS_ENABLED
        ? m(ContributorMetricsSection, { send }) : null;
      case 'vault':     return m(VaultSection, { state, send });
      // Git credentials are folded UNDER API integrations (both are host/origin-bound
      // vault secrets) — ApiIntegrationsSection renders the GitCredentialsSection as a
      // subsection, so there is no standalone git-credentials route/nav entry.
      case 'api-integrations': return m(ApiIntegrationsSection, { send });
      case 'denylist':  return m(DenylistView, { send });
      // The inverse of the denylist: sites peerd itself decided are the user's.
      case 'learned-sites': return m(LearnedOriginsView, { send });
      case 'activity':  return m(ActivityView, { send });
      case 'dweb':      return DWEB_ENABLED ? m(DwebSection, { state, send }) : null;
      default:          return m('p.muted', 'Unknown section.');
    }
  },
};

return OptionsApp;
};
