import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../../packaging/lib.ts';
import {
  assertCharonDwappReport,
  CHARON_DWAPP_BUDGETS,
} from '../../scripts/cdp/charon-dwapp-two-profile.mjs';
import { completeLiveKernelAssemblyFixture } from '../../scripts/acceptance/live-kernel-assembly.mjs';

const digest = 'a'.repeat(64);
const didA = 'did:key:z6MkacceptanceAlice';
const didB = 'did:key:z6MkacceptanceBob';
const lobby = (self: string, owner: boolean, visibility: 'private' | 'public') => ({
  visibility,
  lobbyId: visibility === 'private' ? 'private-lobby-id' : 'lobby-public-acceptance',
  owner: didA,
  self,
  isOwner: owner,
  canStart: owner,
  transport: 'peerd',
  members: [didA, didB].sort(),
});

const profile = (side: 'left' | 'right') => ({
  cutover: completeLiveKernelAssemblyFixture('preview-chrome'),
  vault: { initialized: true, locked: false },
  did: side === 'left' ? didA : didB,
  payload: {
    sha256: digest,
    bundleSha256: digest,
    peerdJsonSha256: digest,
    files: 58,
    bytes: 18_000_000,
  },
  actor: {
    ownerClaimSha256: side === 'left' ? digest : 'b'.repeat(64),
    ownerClaimLength: 24,
    name: 'Charon game developer',
    attached: true,
  },
});

const report = () => ({
  schema: 1,
  ok: true,
  bindings: {
    channel: 'preview',
    browser: 'chrome',
    artifact: { sha256: digest, bytes: 100 },
    tree: { sha256: digest, bytes: 200, files: 10 },
    manifest: { sha256: digest, backgroundEntry: 'background/vault-kernel-preview.js' },
    harness: { sha256: digest },
    browserIdentity: {
      expectedVersion: '151.0.7922.47',
      actualVersion: '151.0.7922.47',
      sha256: digest,
      bytes: 100,
    },
    charon: {
      repository: 'NotASithLord/charon',
      commit: 'f98907200bc3501dd5c669ab8d6c98d1d95fbaa1',
      envelope: { sha256: digest, bytes: 33_000_000 },
      source: { sha256: digest, bytes: 18_000_000, files: 58 },
      bundle: { sha256: digest, bytes: 9_000_000 },
      peerdJson: { sha256: digest, bytes: 2_000 },
      payload: { sha256: digest, bytes: 18_000_000, files: 58 },
      agent: {
        kind: 'bound-app', profile: 'developer', surface: 'code',
        name: 'Charon game developer', runtime: ['observe', 'act'],
      },
      capabilities: ['dweb'],
    },
  },
  postRun: {
    artifact: { sha256: digest, bytes: 100 },
    tree: { sha256: digest, bytes: 200, files: 10 },
    charon: {
      envelope: { sha256: digest, bytes: 33_000_000 },
      source: { sha256: digest, bytes: 18_000_000, files: 58 },
    },
  },
  budgets: { ...CHARON_DWAPP_BUDGETS },
  timings: {
    clock: 'host-monotonic-ms',
    profilesReadyMs: 10,
    importedMs: 20,
    linkedMs: 30,
    privateLobbyMs: 40,
    quickLobbyMs: 50,
    workerRecoveredMs: 60,
    rendererRecoveredMs: 70,
    coopReadyMs: 80,
  },
  observations: {
    profiles: { left: profile('left'), right: profile('right') },
    privateLobby: {
      inviteSha256: digest,
      inviteLength: 24,
      secretRecorded: false,
      left: lobby(didA, true, 'private'),
      right: lobby(didB, false, 'private'),
    },
    quickMatch: {
      beforeRecycle: {
        left: lobby(didA, true, 'public'),
        right: lobby(didB, false, 'public'),
      },
      afterWorker: {
        left: lobby(didA, true, 'public'),
        right: lobby(didB, false, 'public'),
      },
      afterRenderer: {
        left: lobby(didA, true, 'public'),
        right: lobby(didB, false, 'public'),
      },
    },
    workerRecycle: {
      stoppedRunningStatus: 'stopped', newTarget: true, newKernel: true,
    },
    rendererRecycle: {
      priorHostEpoch: 'host-a', hostEpoch: 'host-b', didStable: true,
      dwebLeases: 1, offscreenContexts: 1,
    },
    coop: {
      left: {
        screen: 'game',
        run: { mode: 'multiplayer', seed: 7, authority: true, tick: 10 },
        multiplayer: { scope: 'match-one', transport: 'peerd', members: [didA, didB] },
        tickAdvanced: true,
      },
      right: {
        screen: 'game',
        run: { mode: 'multiplayer', seed: 7, authority: false, tick: 10 },
        multiplayer: { scope: 'match-one', transport: 'peerd', members: [didA, didB] },
        tickAdvanced: true,
      },
    },
    inputsImmutable: true,
  },
});

describe('packaged Charon two-profile release contract', () => {
  test('accepts only exact artifact-bound private/Quick Match/co-op/recycle evidence', () => {
    expect(assertCharonDwappReport(report())).toBeTruthy();
    const mutations: Array<(value: any) => void> = [
      (value) => { value.bindings.channel = 'store'; },
      (value) => { value.bindings.manifest.backgroundEntry = 'background/service-worker.js'; },
      (value) => { value.bindings.charon.commit = 'b'.repeat(40); },
      (value) => { value.bindings.charon.bundle.sha256 = 'b'.repeat(64); },
      (value) => { value.bindings.charon.agent.surface = 'actions'; },
      (value) => { value.bindings.charon.agent.runtime = ['observe']; },
      (value) => { value.observations.profiles.third = profile('left'); },
      (value) => { value.observations.profiles.left.payload.sha256 = 'b'.repeat(64); },
      (value) => { value.observations.profiles.left.payload.files = 57; },
      (value) => { value.observations.profiles.right.actor.attached = false; },
      (value) => { value.observations.profiles.right.actor.ownerClaimSha256 = digest; },
      (value) => { value.observations.profiles.right.actor.ownerClaim = 'raw-capability'; },
      (value) => { value.observations.profiles.right.did = didA; },
      (value) => { value.observations.privateLobby.inviteCode = 'raw-secret'; },
      (value) => { value.observations.privateLobby.right.visibility = 'public'; },
      (value) => { value.observations.privateLobby.right.lobbyId = 'other'; },
      (value) => { value.observations.quickMatch.beforeRecycle.left.canStart = false; },
      (value) => { value.observations.quickMatch.afterWorker.left.lobbyId = 'other'; },
      (value) => { value.observations.quickMatch.afterRenderer.right.members = []; },
      (value) => { value.observations.workerRecycle.stoppedRunningStatus = 'stopping'; },
      (value) => { value.observations.rendererRecycle.hostEpoch = 'host-a'; },
      (value) => { value.observations.rendererRecycle.dwebLeases = 2; },
      (value) => { value.observations.rendererRecycle.offscreenContexts = 2; },
      (value) => { value.observations.coop.right.run.seed = 8; },
      (value) => { value.observations.coop.right.run.authority = true; },
      (value) => { value.observations.coop.left.tickAdvanced = false; },
      (value) => { value.observations.inputsImmutable = false; },
      (value) => { value.postRun.charon.source.sha256 = 'b'.repeat(64); },
      (value) => { value.budgets.launchMs += 1; },
      (value) => { value.timings.coopReadyMs = value.timings.rendererRecoveredMs + value.budgets.launchMs + 1; },
    ];
    for (const mutate of mutations) {
      const candidate = structuredClone(report());
      mutate(candidate);
      expect(() => assertCharonDwappReport(candidate)).toThrow();
    }
  });

  test('drives real packaged profiles, physical import, actor, and lifecycle boundaries', () => {
    const source = readFileSync(join(
      REPO_ROOT, 'scripts', 'cdp', 'charon-dwapp-two-profile.mjs',
    ), 'utf8');
    expect(source).toContain("channel: 'preview', browser: 'chrome'");
    expect(source).toContain('verify: true');
    expect(source).toContain('DOM.setFileInputFiles');
    expect(source).toContain("type: 'apps/open'");
    expect(source).toContain("type: 'app/get-meta'");
    expect(source).toContain("act(leftApp, 'host-private')");
    expect(source).toContain("joinLobby(leftApp, 'quick-match')");
    expect(source).toContain("act(leftApp, 'start-game')");
    expect(source).toContain('left.stopServiceWorker()');
    expect(source).toContain('chrome.offscreen.closeDocument()');
    expect(source).toContain('inspectPinnedCharonSource');
    expect(source).toContain('webRtcLoopbackAcceptance: true');
    expect(source).not.toContain('run-dweb-twopeer');
    expect(source).not.toContain('Target.closeTarget');
    expect(source).not.toContain('inviteCode: inviteCode');
  });
});
