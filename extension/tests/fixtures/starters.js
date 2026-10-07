// @ts-check
// Actual components and packaged inspection. This fixture has no mutation authority.
import m from '/vendor/mithril/mithril.js';
import { StarterSection } from '/home/starter-section.js';
import { StarterReview } from '/options/sections/starter-review.js';
import { inspectEnvelope } from '/peerd-engine/export.js';
const key = new URLSearchParams(location.search).get('starter');
/** @type {string[]} */ const calls = [];
/** @type {any} */ (window).__starterFixtureCalls = calls;
/** @param {any} message */
const send = async message => {
  calls.push(message.type);
  if (message.type === 'apps/list') return {ok:true,apps:[]};
  if (message.type === 'import/inspect') return inspectEnvelope(message.envelope);
  throw new Error('Starter visual fixture has no mutation authority');
};
m.mount(document.getElementById('app'), {view:()=>key
  ? m(StarterReview,{starter:key,send}) : m(StarterSection,{enabled:false,send})});
