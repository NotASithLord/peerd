// @ts-check
// Cold offscreen supervisor channels: exact source/lease admission plus
// demand-only loading. No operation implementation is statically reachable.

import browser from '../shared/browser-api.js';
import { BACKGROUND_MODULE_PATH } from '../shared/build-config.js';
import { ARTIFACT_CHANNEL_PROTOCOL, admitArtifactChannelOffer } from '../shared/artifact-offer.js';
import {
  REPOSITORY_CHANNEL_PROTOCOL,
  admitRepositoryChannelOffer,
} from '../shared/repository-channel.js';
import {
  admitVaultAuthorityOffer, VAULT_AUTHORITY_BOOTSTRAP,
  VAULT_AUTHORITY_PROTOCOL, VAULT_AUTHORITY_RESULT,
} from '../shared/vault-authority-protocol.js';

const ACTOR_CHANNEL_OFFER = 'peerd/actor-channel';
const ACTOR_CHANNEL_PROTOCOL = 1;
const backgroundScriptUrl = browser.runtime.getURL(BACKGROUND_MODULE_PATH);
const runtimeId = browser.runtime?.id;
const extensionOrigin = browser.runtime?.getURL?.('') ?? '';
const backgroundPageUrl = browser.runtime?.getURL?.('_generated_background_page.html') ?? '';

/** @param {{id?:string,url?:string}|null|undefined} sender */
export const isTrustedSender = (sender) => !!sender && !!runtimeId
  && sender.id === runtimeId && !!extensionOrigin
  && typeof sender.url === 'string' && sender.url.startsWith(extensionOrigin);

/** @param {{id?:string,url?:string,tab?:unknown,documentId?:string}|null|undefined} sender */
export const isServiceWorkerSender = (sender) => {
  if (!isTrustedSender(sender) || !backgroundScriptUrl || !backgroundPageUrl
      || (sender && 'tab' in sender)) return false;
  if (sender?.url === backgroundPageUrl) return true;
  return sender?.url === backgroundScriptUrl && !(sender && 'documentId' in sender);
};

/**
 * @param {{
 *   getFeatureLeaseHost:()=>({isActive:(scope:string)=>boolean,ownsLease?:(scope:string,lease:any)=>boolean}|null),
 *   loadControllerBootstrap:()=>Promise<any>,
 *   loadRepositoryHost?:()=>Promise<any>,
 * }} deps
 */
export const registerServiceWorkerChannels = ({
  getFeatureLeaseHost, loadControllerBootstrap,
  loadRepositoryHost = () => import('./repository-host.js'),
}) => {
  /** @type {Set<MessagePort>} */
  const actorPorts = new Set();
  /** @type {Set<Worker>} */
  const vaultAuthorityWorkers = new Set();
  // Chrome actor jobs arrive over a standard MessageChannel transferred by the
  // service worker directly to this exact offscreen WindowClient. This avoids
  // runtime messaging and runtime Port fan-out to other extension frames.
  navigator.serviceWorker?.addEventListener('message', (event) => {
    if (event.data?.type === 'peerd/controller-channel' && event.ports?.length === 1) {
      if (!getFeatureLeaseHost()?.isActive('controller')) {
        event.ports[0].close();
        return;
      }
      loadControllerBootstrap().then(
        ({ acceptControllerOffer }) => acceptControllerOffer(event),
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
    const vaultAuthorityAdmission = admitVaultAuthorityOffer(
      event,
      backgroundScriptUrl,
      getFeatureLeaseHost()?.isActive('vault-authority') === true,
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
      const worker = new Worker(browser.runtime.getURL('offscreen/vault-authority-worker.js'), {
        type: 'module', name: 'peerd-vault-authority',
      });
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
      loadRepositoryHost().then(
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
    const artifactAdmission = admitArtifactChannelOffer(
      event,
      backgroundScriptUrl,
      getFeatureLeaseHost()?.isActive('dom-host') === true,
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
      import('./artifact-host.js').then(
        ({ acceptArtifactOffer }) => acceptArtifactOffer(event),
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
    if (!getFeatureLeaseHost()?.isActive('controller')) {
      actorPort.close();
      return;
    }
    actorPorts.add(actorPort);
    actorPort.addEventListener('close', () => actorPorts.delete(actorPort), { once: true });
    Promise.all([import('./actor-channel-host.js'), import('./actor-runner.js')])
      .then(([{ bindActorChannel }, { runActor, abortActor }]) => bindActorChannel({
        port: actorPort, channelId: event.data.channelId,
        run: runActor, abort: abortActor,
        workerUrl: browser.runtime.getURL('offscreen/actor-worker.js'),
      }))
      .catch(() => { try { actorPort.close(); } catch { /* already gone */ } });
  });
  return Object.freeze({ actorPorts, vaultAuthorityWorkers });
};
