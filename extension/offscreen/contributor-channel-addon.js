// @ts-check
// Preview/dev-only offscreen admission for the exact Contributor Metrics
// channel. Store packaging replaces this whole module with an empty addon.

export const contributorChannelAddon = Object.freeze({
  loadContributorHost: () => import('./semantic-routes/contributor.js'),
  loadContributorOffer: () => import('../shared/contributor-channel.js')
    .then((module) => module.parseContributorOffer),
});
