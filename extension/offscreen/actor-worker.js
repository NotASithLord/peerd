// @ts-check
// Preview/dev actor entry. Store packaging replaces this whole entry with the
// committed no-contributor entry; the common actor runtime stays single-source.

import { projectContributorSettlement } from '/peerd-runtime/controller-contributor.js';
import { startActorWorker } from './actor-worker-runtime.js';

startActorWorker((result, program, metadata) => {
  const contributor = metadata.actorType === 'web' && metadata.backing === 'tab'
    ? projectContributorSettlement(result, program.provider, program.model) : null;
  return contributor ? { ...result, contributor } : result;
});
