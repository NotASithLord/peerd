// @ts-check

/**
 * Map each state-bearing UI port name to its exact owning document predicate.
 * Unknown names fail closed.
 *
 * @param {string} name
 * @param {unknown} sender
 * @param {{
 *   sidepanel: (sender: unknown) => boolean,
 *   home: (sender: unknown) => boolean,
 *   evaluation: (sender: unknown) => boolean,
 * }} predicates
 */
export const isAuthorizedUiPortSender = (name, sender, predicates) => {
  if (name === 'sidepanel') return predicates.sidepanel(sender);
  if (name === 'home') return predicates.home(sender);
  if (name === 'eval') return predicates.evaluation(sender);
  return false;
};
