// @ts-check
// Actual components and packaged inspection. This fixture has no mutation
// authority: only ?state=added answers an add, so its frame can draw the page
// after one.
import m from '/vendor/mithril/mithril.js';
import { DiscoverSection } from '/home/discover-section.js';
import { StarterReview } from '/options/sections/starter-review.js';
import { inspectEnvelope } from '/peerd-engine/export.js';
const params = new URLSearchParams(location.search);
const key = params.get('starter');
const added = params.get('state') === 'added';
/** @type {string[]} */ const calls = [];
/** @type {any} */ (window).__starterFixtureCalls = calls;
/** @param {any} message */
const send = async message => {
  calls.push(message.type);
  if (message.type === 'apps/list') return {ok:true,apps:[]};
  if (message.type === 'import/inspect') return inspectEnvelope(message.envelope);
  if (message.type === 'import/apply' && added) return {ok:true,kind:'app',id:'app-fixture'};
  throw new Error('Starter visual fixture has no mutation authority');
};
m.mount(document.getElementById('app'), {view:()=>key
  ? m(StarterReview,{starter:key,send}) : m(DiscoverSection,{enabled:false,send})});
