// @ts-check

import { createGitCredentialRoutes } from '../shared/repository-channel.js';
import {
  ensureDpopJkt,
  loadDpopJkt,
  makeDpopKeyStore,
  makeOriginCredentialRoutes,
} from '../peerd-egress/kernel-storage.js';

/** @param {Record<string,any>} deps */
export const makeKernelGitCredentialRoutes = ({ vault, auditLog, isLockedError }) =>
  createGitCredentialRoutes({
    vault, isLockedError,
    audit: (event) => { void auditLog.append(event).catch(() => {}); },
  });

/** @param {Record<string,any>} deps */
export const makeKernelOriginCredentialRoutes = ({
  vault, auditLog, isLockedError, idb,
  learnKeyedOrigin = (/** @type {string} */ _origin) => {},
  forgetKeyedOrigin = (/** @type {string} */ _origin) => {},
}) => {
  const store = makeDpopKeyStore({ get: idb.get, put: idb.put, del: idb.del });
  const authority = {
    ...store,
    audit: (/** @type {any} */ event) => { void auditLog.append(event).catch(() => {}); },
  };
  return makeOriginCredentialRoutes({
    vault, isLockedError,
    ensureDpopKey: (origin) => ensureDpopJkt(origin, authority),
    readDpopJkt: (origin) => loadDpopJkt(origin, store),
    deleteDpopKey: (origin) => store.remove(origin),
    audit: (event) => {
      void auditLog.append(event).catch(() => {});
      if (event?.type === 'origin_credential_added'
          && typeof event?.details?.origin === 'string') {
        learnKeyedOrigin(event.details.origin);
      } else if (event?.type === 'origin_credential_removed'
          && typeof event?.details?.origin === 'string') {
        forgetKeyedOrigin(event.details.origin);
      }
    },
  });
};
