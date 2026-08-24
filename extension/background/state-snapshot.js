// @ts-check
// Browser-neutral UI snapshot assembly. The service worker injects the live
// authority stores and projections; this module owns only the exact public
// state shape and cannot register listeners or create feature hosts.

/** @param {Record<string,any>} deps */
export const makeStateSnapshotBuilder = (deps) => {
  const { getActorIsolation, actorIsolationReady, actorLiveProjection, confirmCoordinator, confirmSettleNotes, ensureSettingsReady, hydrateLocalModelAvailability, isTurnBusy, listProviders, liveProviderModelStatus, localModelState, normalizeTally, profileState, providerConfigRevision, reconcileOnboardingLatch, resolveActiveProvider, resolveComposerReadiness, resolvePermission, runtimeCapabilities, sessionCache, sessions, settingsStore, vault } = deps;
  return async () => {
    // A cold MV3 worker can resume the vault and accept a UI port before the
    // asynchronous chrome.storage settings read finishes. The snapshot must not
    // observe channel defaults in that window: if the user selected a keyless
    // provider (Ollama / Local WebGPU), the default Anthropic projection reports
    // hasKey:false and strands the already-open composer until some unrelated
    // mutation happens to push state again (issue #384).
    //
    let settingsAvailable = true;
    try { await ensureSettingsReady(); }
    catch {
      // A transient storage failure must not turn channel defaults into a
      // confirmed provider choice for the rest of this worker's lifetime. The
      // full hydration gate retries storage AND reapplies boot-time consumers
      // such as the vault lock policy; a raw store load would leave those stale.
      try { await ensureSettingsReady(); }
      catch { settingsAvailable = false; }
    }
    await actorIsolationReady;
    const sessionId = await sessionCache.sessionGet('currentSessionId');
    // prfEnrolled is cheap to read (one kv.get) and the side panel uses it
    // (permission resolved per path below because it needs the session record.)
    // both pre-unlock (to show the Touch ID button) and post-unlock (to
    // show the enroll/disable toggle in settings). Surfaced on every push.
    const prf = await vault.prfStatus();
    // why: the gate/settings need to know whether a recovery passphrase
    // exists. The unlock screen only offers the passphrase path when it
    // can succeed, and settings shows "Set" vs "Change". Cheap kv.get.
    const hasRecovery = await vault.hasRecoveryPassphrase();
    // Vault-locked path: emit a minimal state without touching IDB
    // (session reads would surface as null anyway).
    if (vault.isLocked()) {
      const permission = await resolvePermission(null);
      return {
        vault: {
          initialized: await vault.isInitialized(),
          locked: true,
          unlockedAt: 0,
          prfEnrolled: prf.enrolled,
          hasRecovery,
          // §5g: WHY it locked ('idle'|'manual'|null) - the unlock screen's
          // one added sentence renders only for an idle lock.
          lockReason: vault.lockReason?.() ?? null,
        },
        session: { sessionId: null, messages: [], permission, customSystemPrompt: null, toolManifest: null },
        providers: {
          current: resolveActiveProvider().name,
          hasKey: false,
          model: resolveActiveProvider().model,
          defaultRunnerModel: resolveActiveProvider().defaultRunnerModel,
          configRevision: providerConfigRevision,
        },
        composer: {
          provider: resolveActiveProvider().name,
          model: resolveActiveProvider().model,
          keyless: false,
          credentialReady: false,
          localReady: false,
          canSend: false,
          reason: 'vault-locked',
        },
        capabilities: { actorExecution: { ...getActorIsolation() }, ...runtimeCapabilities },
        settings: { ...settingsStore.get() },
        pendingConfirm: null,
        streaming: false,
        actors: {},
        spawned: { byToolUse: {}, sessions: {} },
        asyncTasks: {},
      };
    }
    // Unlocked path.
    const session = sessionId ? (await sessions.get(/** @type {any} */ (sessionId))) ?? null : null;
    const permission = await resolvePermission(session);
    // Default profile: the home page gates first-run onboarding on
    // onboardingComplete and the transcript labels assistant rows with
    // peerName. Only surfaced when unlocked: the locked push deliberately
    // omits it so the surfaces' "assume complete" default holds at the gate
    // and onboarding can never flash before a real unlock. Reconcile FIRST
    // so the same push that would re-show the funnel to an established
    // install carries the closed latch instead.
    await reconcileOnboardingLatch();
    const profile = await profileState.get();
    // providers remains the Settings/default-for-NEW-chats projection. Composer
    // readiness is separate because an existing chat stays bound to the provider
    // recorded on its session even after the user changes that future default.
    const activeProv = resolveActiveProvider();
    const composerProvider = session?.provider ?? activeProv.name;
    const composerModel = session?.model ?? activeProv.model;
    if (activeProv.name === 'local-webgpu' || composerProvider === 'local-webgpu') {
      await hydrateLocalModelAvailability().catch(() => false);
    }
    const providerRows = listProviders();
    const ollamaModels = liveProviderModelStatus('ollama');
    const defaultReadiness = await resolveComposerReadiness({
      provider: activeProv.name,
      model: activeProv.model,
      providers: providerRows,
      getSecret: (/** @type {string} */ name) => vault.getSecret(name),
      localModelAvailable: localModelState.available(),
      ollamaModels,
      settingsAvailable,
    });
    const composer = composerProvider === activeProv.name && composerModel === activeProv.model
      ? Object.freeze({ ...defaultReadiness, model: composerModel })
      : await resolveComposerReadiness({
          provider: composerProvider,
          model: composerModel,
          providers: providerRows,
          getSecret: (/** @type {string} */ name) => vault.getSecret(name),
          localModelAvailable: localModelState.available(),
          ollamaModels,
          settingsAvailable,
         });
    const hasKey = settingsAvailable && defaultReadiness.credentialReady;
    // Take every awaited store read before capturing the in-memory projection.
    // Provider tool-use ids can repeat, so an older snapshot must never cross an
    // await and arrive after a newer correlated actor-start for the same id.
    const vaultInitialized = await vault.isInitialized();
    const liveActors = actorLiveProjection.snapshot(/** @type {string | null} */ (sessionId));
    return {
      vault: {
        initialized: vaultInitialized,
        locked: false,
        unlockedAt: vault.unlockedAt(),
        prfEnrolled: prf.enrolled,
        hasRecovery,
      },
      session: {
        sessionId: session?.sessionId ?? null,
        messages: session?.messages ?? [],
        permission,
        // The provider this chat is BOUND to (sessions snapshot it on
        // first send). The panel gates provider-specific affordances on
        // it. For example, the reasoning-effort dial only renders where effort
        // is actually honored (Anthropic adapter; OpenRouter ignores
        // the reasoning object entirely today, see TODO.md).
        provider: session?.provider ?? null,
        // Cost/usage tally for the meter (feature 06). Normalized so the
        // UI always gets a full shape, even for pre-feature sessions.
        cost: normalizeTally(session?.cost),
        // Per-session /system instructions. The chat header chip renders
        // from this so the augmentation's presence is always visible.
        customSystemPrompt: session?.customSystemPrompt ?? null,
        // Per-session /tools manifest has the same visibility contract. A
        // narrowed toolset silently changes what the model can do, so its
        // presence must be visible where the chat happens (mode-row chip).
        toolManifest: session?.toolManifest ?? null,
      },
      providers: {
        current: activeProv.name,
        hasKey,
        model: activeProv.model,
        configRevision: providerConfigRevision,
        // why: the web actor's fast default for this provider. The Settings
        // "Web actor model" field shows it as the blank placeholder so "blank"
        // honestly reads as e.g. claude-haiku-4-5, not "inherit".
        defaultRunnerModel: activeProv.defaultRunnerModel,
      },
      composer,
      capabilities: { actorExecution: { ...getActorIsolation() }, ...runtimeCapabilities },
      profile: {
        id: profile.id,
        peerName: profile.peerName,
        onboardingComplete: !!profile.onboardingComplete,
      },
      settings: { ...settingsStore.get() },
      // The snapshot is the switch-back and late-joiner path for confirmation
      // state. Live confirm/request events remain the fast path; this selects only
      // prompts owned by the chat represented by this snapshot.
      pendingConfirm: confirmCoordinator.getPendingForOwner(
        typeof sessionId === 'string' ? sessionId : null,
      ),
      // Self-settled confirms for THIS chat (timeout / stop / closed panel) - the
      // panel folds these into its transcript notes so a settle that happened
      // while no surface was open is still tellable (§4e).
      confirmSettleNotes: sessionId ? (confirmSettleNotes.get(/** @type {string} */ (sessionId)) ?? []) : [],
      // Live actor projections are part of the fresh snapshot, not a lucky stream
      // of events seen only by panels that were already open. Every row is scoped
      // to this viewed root before it crosses the UI boundary.
      actors: liveActors.actors,
      actorProjectionEpoch: liveActors.actorProjectionEpoch,
      actorProjectionRevision: liveActors.actorProjectionRevision,
      spawned: liveActors.spawned,
      asyncTasks: liveActors.asyncTasks,
      // Per-session truth: is THIS chat's turn in flight? Lets the panel
      // re-arm its spinner/Stop affordances when the user switches back
      // to a conversation that kept streaming in the background.
      streaming: sessionId ? isTurnBusy(/** @type {any} */ (sessionId)) : false,
    };
  };
};
