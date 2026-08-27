// @ts-check
// Cold offscreen supervisor channels: exact source/lease admission plus
// demand-only loading. No operation implementation is statically reachable.

import browser from '../shared/browser-api.js';
import { ARTIFACT_CHANNEL_PROTOCOL, admitArtifactChannelOffer } from '../shared/artifact-offer.js';
import {
  admitVaultAuthorityOffer, VAULT_AUTHORITY_BOOTSTRAP,
  VAULT_AUTHORITY_PROTOCOL, VAULT_AUTHORITY_RESULT,
} from '../shared/vault-authority-protocol.js';
import {
  LOCAL_MODEL_CHANNEL_PROTOCOL, LOCAL_MODEL_CHANNEL_RESULT,
  REPOSITORY_CHANNEL_OFFER, REPOSITORY_CHANNEL_PROTOCOL,
  parseLocalModelChannelOffer, parseRepositoryChannelOffer,
} from '../shared/feature-lease-protocol.js';
import {
  VOICE_CHANNEL_OFFER, VOICE_CHANNEL_PROTOCOL, VOICE_CHANNEL_RESULT,
  parseVoiceChannelOffer,
} from '../shared/voice-channel.js';
import { makeBoundedModuleLoader } from '../shared/bounded-module-load.js';
import {
  backgroundScriptUrl, isServiceWorkerSender, isTrustedSender,
} from './sender-checks.js';

const ACTOR_CHANNEL_OFFER = 'peerd/actor-channel';
const ACTOR_CHANNEL_PROTOCOL = 1;
export { isServiceWorkerSender, isTrustedSender } from './sender-checks.js';

/** @param {any} event @param {string} workerUrl @param {(lease:any)=>boolean} ownsLease */
export const admitRepositoryChannelOffer = (event, workerUrl, ownsLease) => {
  if (event?.data?.type !== REPOSITORY_CHANNEL_OFFER) {
    return { matched: false, ok: false, reason: 'not-repository-offer', offer: null };
  }
  const source = /** @type {{scriptURL?:unknown}|null} */ (event.source ?? null);
  const offer = parseRepositoryChannelOffer(event.data);
  if (event.isTrusted !== true || source?.scriptURL !== workerUrl) {
    return { matched: true, ok: false, reason: 'sender-invalid', offer };
  }
  if (!Array.isArray(event.ports) || event.ports.length !== 1 || !event.ports[0]) {
    return { matched: true, ok: false, reason: 'port-invalid', offer };
  }
  if (!offer) return { matched: true, ok: false, reason: 'offer-invalid', offer: null };
  return ownsLease(offer.lease)
    ? { matched: true, ok: true, reason: null, offer }
    : { matched: true, ok: false, reason: 'lease-invalid', offer };
};

/** @param {any} event @param {string} workerUrl @param {(lease:any)=>boolean} ownsLease */
export const admitLocalModelChannelOffer = (event, workerUrl, ownsLease) => {
  if (event?.data?.type !== 'peerd/local-model-channel') {
    return { matched: false, ok: false, offer: null };
  }
  const source = /** @type {{scriptURL?:unknown}|null} */ (event.source ?? null);
  const offer = parseLocalModelChannelOffer(event.data);
  const ok = event.isTrusted === true && source?.scriptURL === workerUrl
    && event.ports?.length === 1 && !!event.ports[0] && !!offer
    && ownsLease(offer.lease);
  return { matched: true, ok, offer };
};

/**
 * @param {{
 *   getFeatureLeaseHost:()=>({isActive:(scope:string)=>boolean,ownsLease?:(scope:string,lease:any)=>boolean}|null),
 *   loadControllerBootstrap:()=>Promise<any>,
 *   loadRepositoryHost?:()=>Promise<any>,
 *   loadLocalModelHost?:()=>Promise<any>,
 *   loadContributorHost?:()=>Promise<any>,
 *   loadArtifactHost?:()=>Promise<any>,
 *   loadVoiceHost?:()=>Promise<any>,
 *   loadActorHost?:()=>Promise<any>,
 *   actorPorts?:Set<MessagePort>,
 *   vaultAuthorityWorkers?:Set<Worker>,
 *   createVaultAuthorityWorker?:()=>Worker,
 *   moduleLoadTimeoutMs?:number,
 * }} deps
 */
export const createServiceWorkerChannels = ({
  getFeatureLeaseHost, loadControllerBootstrap,
  loadRepositoryHost = () => import('./repository-host.js'),
  loadLocalModelHost = () => import('./local-model.js'),
  loadContributorHost = () => import('./semantic-routes/contributor.js'),
  loadArtifactHost = () => import('./artifact-host.js'),
  loadVoiceHost = () => import('./voice-channel-host.js'),
  loadActorHost = () => Promise.all([
    import('./actor-channel-host.js'), import('./actor-runner.js'),
  ]),
  actorPorts = new Set(),
  vaultAuthorityWorkers = new Set(),
  moduleLoadTimeoutMs = 10_000,
  createVaultAuthorityWorker = () => new Worker(
    browser.runtime.getURL('offscreen/vault-authority-worker.js'),
    { type: 'module', name: 'peerd-vault-authority' },
  ),
}) => {
  const bounded = (/** @type {()=>Promise<any>} */ load, /** @type {string} */ code) =>
    makeBoundedModuleLoader(load, {
      timeoutMs: moduleLoadTimeoutMs,
      loadCode: `${code}-load-failed`, timeoutCode: `${code}-load-timeout`,
    });
  const loadController = bounded(loadControllerBootstrap, 'controller-host');
  const loadRepository = bounded(loadRepositoryHost, 'repository-host');
  const loadLocalModel = bounded(loadLocalModelHost, 'local-model-host');
  const loadContributor = bounded(loadContributorHost, 'contributor-host');
  const loadArtifact = bounded(loadArtifactHost, 'artifact-host');
  const loadVoice = bounded(loadVoiceHost, 'voice-host');
  const loadActor = bounded(loadActorHost, 'actor-host');
  const loadContributorOffer = makeBoundedModuleLoader(
    () => import('../shared/contributor-channel.js').then((module) => module.parseContributorOffer),
  );
  // Chrome actor jobs arrive over a standard MessageChannel transferred by the
  // service worker directly to this exact offscreen WindowClient. This avoids
  // runtime messaging and runtime Port fan-out to other extension frames.
  const onMessage = (/** @type {MessageEvent} */ event) => {
    if (event.data?.type === 'peerd/controller-channel' && event.ports?.length === 1) {
      const lease = event.data.lease;
      if (getFeatureLeaseHost()?.ownsLease?.('controller', lease) !== true) {
        event.ports[0].close();
        return;
      }
      loadController().then(
        ({ acceptControllerOffer }) => {
          if (getFeatureLeaseHost()?.ownsLease?.('controller', lease) !== true) {
            event.ports[0].close();
            return;
          }
          acceptControllerOffer(event);
        },
        () => {
          try {
            event.ports[0].postMessage({
              protocol: event.data.protocol,
              channelId: event.data.channelId,
              buildDigest: event.data.buildDigest,
              kernelEpoch: event.data.kernelEpoch,
              hostEpoch: null,
              sequence: 1,
              type: 'controller/unavailable',
              code: 'controller-host-load-failed',
            });
          } catch { /* channel already gone */ }
          event.ports[0].close();
        },
      );
      return;
    }
    if (event.data?.type === VOICE_CHANNEL_OFFER) {
      const port = event.ports?.[0];
      const source = /** @type {{scriptURL?:unknown}|null} */ (event.source ?? null);
      const offer = parseVoiceChannelOffer(event.data);
      const admitted = event.isTrusted === true && source?.scriptURL === backgroundScriptUrl
        && event.ports?.length === 1 && !!port && !!offer
        && getFeatureLeaseHost()?.ownsLease?.('media-host', offer.lease) === true;
      if (!admitted || !offer) {
        try { port?.close(); } catch {}
        return;
      }
      loadVoice().then(
        ({ acceptVoiceChannelOffer }) => acceptVoiceChannelOffer(
          event,
          (/** @type {any} */ lease) => getFeatureLeaseHost()
            ?.ownsLease?.('media-host', lease) === true,
        ),
        () => {
          try { port.postMessage({
            type: VOICE_CHANNEL_RESULT,
            protocol: VOICE_CHANNEL_PROTOCOL,
            requestId: offer.requestId,
            result: {
              ok: false, code: 'voice-host-load-failed',
              error: 'Feature unavailable. Try again.', outcomeKnown: true,
              retryable: true, phase: 'startup',
            },
          }); } catch {}
          try { port.close(); } catch {}
        },
      );
      return;
    }
    const vaultAuthorityAdmission = admitVaultAuthorityOffer(
      event,
      backgroundScriptUrl,
      (lease) => getFeatureLeaseHost()?.ownsLease?.('vault-authority', lease) === true,
    );
    if (vaultAuthorityAdmission.matched) {
      const port = event.ports?.[0];
      if (!vaultAuthorityAdmission.ok || !port || !vaultAuthorityAdmission.offer) {
        if (port && vaultAuthorityAdmission.offer) {
          try {
            port.postMessage({
              type: VAULT_AUTHORITY_RESULT,
              protocol: VAULT_AUTHORITY_PROTOCOL,
              channelId: vaultAuthorityAdmission.offer.channelId,
              requestId: 'bootstrap-error',
              ok: false,
              error: `vault authority offer refused: ${vaultAuthorityAdmission.reason}`,
            });
          } catch { /* invalid/closed */ }
        }
        for (const candidate of event.ports ?? []) {
          try { candidate.close(); } catch { /* invalid/closed */ }
        }
        return;
      }
      if (getFeatureLeaseHost()?.ownsLease?.(
        'vault-authority', vaultAuthorityAdmission.offer.lease,
      ) !== true) {
        try { port.close(); } catch { /* already closed */ }
        return;
      }
      const worker = createVaultAuthorityWorker();
      vaultAuthorityWorkers.add(worker);
      worker.addEventListener('error', () => {
        vaultAuthorityWorkers.delete(worker);
        try { port.close(); } catch { /* already closed */ }
        try { worker.terminate(); } catch { /* already stopped */ }
      }, { once: true });
      try {
        worker.postMessage({
          type: VAULT_AUTHORITY_BOOTSTRAP,
          protocol: VAULT_AUTHORITY_PROTOCOL,
          channelId: vaultAuthorityAdmission.offer.channelId,
        }, [port]);
      } catch {
        vaultAuthorityWorkers.delete(worker);
        try { port.close(); } catch { /* already closed */ }
        try { worker.terminate(); } catch { /* already stopped */ }
      }
      return;
    }
    const repositoryHost = getFeatureLeaseHost();
    const repositoryAdmission = admitRepositoryChannelOffer(
      event,
      backgroundScriptUrl,
      (lease) => repositoryHost?.ownsLease?.('controller', lease) === true,
    );
    if (repositoryAdmission.matched) {
      const repositoryPort = event.ports?.[0];
      if (!repositoryAdmission.ok) {
        try {
          repositoryPort?.postMessage({
            type: 'repository/result',
            protocol: REPOSITORY_CHANNEL_PROTOCOL,
            channelId: repositoryAdmission.offer?.channelId,
            ok: false,
            code: 'repository-channel-refused',
            error: repositoryAdmission.reason,
            outcomeKnown: true,
          });
        } catch { /* invalid/closed */ }
        try { repositoryPort?.close(); } catch { /* invalid/closed */ }
        return;
      }
      loadRepository().then(
        ({ acceptRepositoryOffer }) => acceptRepositoryOffer(event, {
          ownsLease: (/** @type {any} */ lease) => getFeatureLeaseHost()
            ?.ownsLease?.('controller', lease) === true,
        }),
        () => {
          try {
            repositoryPort?.postMessage({
              type: 'repository/result',
              protocol: REPOSITORY_CHANNEL_PROTOCOL,
              channelId: repositoryAdmission.offer?.channelId,
              ok: false,
              code: 'repository-host-load-failed',
              error: 'repository host failed to load',
              outcomeKnown: true,
            });
          } catch { /* invalid/closed */ }
          try { repositoryPort?.close(); } catch { /* invalid/closed */ }
        },
      );
      return;
    }
    const localModelAdmission = admitLocalModelChannelOffer(
      event, backgroundScriptUrl,
      (lease) => getFeatureLeaseHost()?.ownsLease?.('model-host', lease) === true,
    );
    if (localModelAdmission.matched) {
      const localModelOffer = localModelAdmission.offer;
      const port = event.ports?.[0];
      if (!localModelAdmission.ok || !localModelOffer) {
        try { port?.postMessage({
          type: LOCAL_MODEL_CHANNEL_RESULT, protocol: LOCAL_MODEL_CHANNEL_PROTOCOL,
          channelId: localModelOffer?.channelId ?? '', ok: false,
          error: 'local-model-channel-refused', outcomeKnown: true,
        }); } catch {}
        try { port?.close(); } catch {}
        return;
      }
      loadLocalModel().then(
        ({ acceptLocalModelOffer }) => acceptLocalModelOffer(event, {
          ownsLease: (/** @type {any} */ lease) => getFeatureLeaseHost()
            ?.ownsLease?.('model-host', lease) === true,
        }),
        () => {
          try { port?.postMessage({
            type: LOCAL_MODEL_CHANNEL_RESULT, protocol: LOCAL_MODEL_CHANNEL_PROTOCOL,
            channelId: localModelOffer.channelId, ok: false,
            error: 'local-model-host-load-failed', outcomeKnown: true,
          }); } catch {}
          try { port?.close(); } catch {}
        },
      );
      return;
    }
    if (event.data?.type === 'peerd/contributor-channel') {
      const port = event.ports?.[0];
      loadContributorOffer().then((parseContributorOffer) => {
        const contributorOffer = parseContributorOffer(event.data);
        const source = /** @type {{scriptURL?:unknown}|null} */ (event.source ?? null);
        const admitted = event.isTrusted === true && source?.scriptURL === backgroundScriptUrl
          && event.ports?.length === 1 && !!contributorOffer
          && getFeatureLeaseHost()?.ownsLease?.('controller', contributorOffer.lease) === true;
        if (!admitted) { try { port?.close(); } catch {} return; }
        loadContributor().then(
          ({ acceptContributorOffer }) => acceptContributorOffer(event, {
            ownsLease: (/** @type {any} */ lease) => getFeatureLeaseHost()
              ?.ownsLease?.('controller', lease) === true,
          }),
          () => { try { port?.close(); } catch {} },
        );
      }, () => { try { port?.close(); } catch {} });
      return;
    }
    const artifactAdmission = admitArtifactChannelOffer(
      event,
      backgroundScriptUrl,
      (lease) => getFeatureLeaseHost()?.ownsLease?.('dom-host', lease) === true,
    );
    if (artifactAdmission.matched) {
      const artifactPort = event.ports?.[0];
      if (!artifactAdmission.ok) {
        if (artifactPort && artifactAdmission.offer) {
          try {
            artifactPort.postMessage({
              protocol: ARTIFACT_CHANNEL_PROTOCOL,
              channelId: artifactAdmission.offer.channelId,
              ok: false,
              error: {
                name: artifactAdmission.reason === 'lease-inactive'
                  ? 'ArtifactHostLeaseError'
                  : artifactAdmission.reason === 'payload-too-large'
                    ? 'ArtifactPayloadTooLargeError' : 'ArtifactOperationDeniedError',
                message: artifactAdmission.reason === 'lease-inactive'
                  ? 'artifact host lease is inactive'
                  : artifactAdmission.reason === 'payload-too-large'
                    ? 'artifact operation payload exceeded its limit'
                    : 'artifact operation denied',
                outcomeKnown: true,
              },
            });
          } catch { /* invalid/closed */ }
        }
        for (const port of event.ports ?? []) {
          try { port.close(); } catch { /* invalid/closed */ }
        }
        return;
      }
      loadArtifact().then(
        ({ acceptArtifactOffer }) => {
          if (getFeatureLeaseHost()?.ownsLease?.(
            'dom-host', artifactAdmission.offer?.lease,
          ) !== true) {
            try { artifactPort?.close(); } catch {}
            return;
          }
          acceptArtifactOffer(event);
        },
        () => {
          try {
            artifactPort?.postMessage({
              protocol: ARTIFACT_CHANNEL_PROTOCOL,
              channelId: artifactAdmission.offer?.channelId,
              ok: false,
              error: { name: 'ArtifactHostLoadError', message: 'artifact host failed to load' },
            });
          } catch { /* invalid/closed */ }
          try { artifactPort?.close(); } catch { /* invalid/closed */ }
        },
      );
      return;
    }
    const source = /** @type {{ scriptURL?: string } | null} */ (event.source);
    if (!event.isTrusted
        || source?.scriptURL !== backgroundScriptUrl
        || event.data?.type !== ACTOR_CHANNEL_OFFER
        || event.data?.protocol !== ACTOR_CHANNEL_PROTOCOL
        || typeof event.data?.channelId !== 'string'
        || event.ports?.length !== 1) return;
    const actorPort = event.ports[0];
    const actorLease = event.data.lease;
    if (getFeatureLeaseHost()?.ownsLease?.('controller', actorLease) !== true) {
      actorPort.close();
      return;
    }
    actorPorts.add(actorPort);
    actorPort.addEventListener('close', () => actorPorts.delete(actorPort), { once: true });
    loadActor()
      .then(([{ bindActorChannel }, { runActor, abortActor }]) => {
        if (getFeatureLeaseHost()?.ownsLease?.('controller', actorLease) !== true) {
          try { actorPort.close(); } catch { /* already gone */ }
          return;
        }
        bindActorChannel({
          port: actorPort, channelId: event.data.channelId,
          run: runActor, abort: abortActor,
          workerUrl: browser.runtime.getURL('offscreen/actor-worker.js'),
        });
      })
      .catch(() => { try { actorPort.close(); } catch { /* already gone */ } });
  };
  return Object.freeze({ onMessage, actorPorts, vaultAuthorityWorkers });
};

export const registerServiceWorkerChannels = (/** @type {Parameters<typeof createServiceWorkerChannels>[0]} */ deps) => {
  const channels = createServiceWorkerChannels(deps);
  navigator.serviceWorker?.addEventListener('message', channels.onMessage);
  navigator.serviceWorker?.startMessages?.();
  return channels;
};
