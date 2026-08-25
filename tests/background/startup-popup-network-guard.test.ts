import { describe, expect, test } from 'bun:test';
import {
  makeSerializedDnrSessionRules,
  makeStartupPopupNetworkGuard,
} from '../../extension/background/startup-popup-network-guard.js';
import {
  buildPrivateNetworkBlockRules,
  CHROME_DNR_RESOURCE_TYPES,
} from '../../extension/peerd-egress/denylist/dnr-rules.js';
import { PRIVATE_NETWORK_RULE_DIGESTS } from '../../extension/shared/private-network-rule-ids.js';

const rule = (id: number, tabIds: number[], action = 'block') => ({
  id, priority: 4, action: { type: action },
  condition: {
    tabIds, resourceTypes: ['main_frame', 'sub_frame', 'xmlhttprequest', 'websocket'],
    ...(id === 4 ? { requestDomains: ['localhost'] }
      : { regexFilter: '^https?://private', isUrlFilterCaseSensitive: false }),
  },
});

describe('startup popup network guard', () => {
  test('serializes every owner of the shared DNR session rule set', async () => {
    const calls: number[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const lane = makeSerializedDnrSessionRules({
      getSessionRules: async () => [],
      updateSessionRules: async (update: any) => {
        calls.push(update.removeRuleIds[0]);
        if (calls.length === 1) await held;
      },
    });
    const first = lane.updateSessionRules({ removeRuleIds: [1], addRules: [] });
    const second = lane.updateSessionRules({ removeRuleIds: [2], addRules: [] });
    await Promise.resolve();
    expect(calls).toEqual([1]);
    release();
    await Promise.all([first, second]);
    expect(calls).toEqual([1, 2]);
  });

  test('a stale rich projection cannot commit after startup adoption', async () => {
    let rules = [rule(4, [7])];
    let releaseRich!: () => void;
    const heldRich = new Promise<void>((resolve) => { releaseRich = resolve; });
    let calls = 0;
    const lane = makeSerializedDnrSessionRules({
      getSessionRules: async () => rules,
      updateSessionRules: async (update: any) => {
        calls += 1;
        if (calls === 1) await heldRich;
        rules = [
          ...rules.filter((candidate) => !update.removeRuleIds.includes(candidate.id)),
          ...update.addRules,
        ];
      },
    });
    const staleRich = lane.updateSessionRules({
      removeRuleIds: [4], addRules: [rule(4, [7])],
    });
    const guard = makeStartupPopupNetworkGuard(lane, [4]);
    const adopted = guard.adopt(7, 9);
    await Promise.resolve();
    expect(calls).toBe(1);
    releaseRich();
    await staleRich;
    await expect(adopted).resolves.toBe(true);
    expect(rules[0].condition.tabIds).toEqual([7, 9]);
  });

  test('copies only block rules proving ownership of the exact source', async () => {
    let rules = [
      rule(1, [7]), rule(4, [7, 8]), rule(5, [7, 8]),
      rule(6, [7]), rule(2, [7], 'allow'),
    ];
    const updates: any[] = [];
    const guard = makeStartupPopupNetworkGuard({
      getSessionRules: async () => rules,
      updateSessionRules: async (update) => {
        updates.push(update);
        rules = [
          ...rules.filter((candidate) => !update.removeRuleIds.includes(candidate.id)),
          ...update.addRules,
        ];
      },
    }, [4, 5]);

    expect(await guard.adopt(7, 9)).toBe(true);
    expect(updates).toHaveLength(1);
    expect(updates[0].removeRuleIds).toEqual([1, 4, 5, 6]);
    expect(updates[0].addRules.map((entry: any) => entry.condition.tabIds)).toEqual([
      [7, 9], [7, 8, 9], [7, 8, 9], [7, 9],
    ]);
    expect(guard.tabIds()).toEqual([9]);
    expect(guard.hasSourceEvidence(7)).toBe(true);
    expect(guard.hasSourceEvidence(9)).toBe(true);
  });

  test('absent source proof changes nothing', async () => {
    const updates: any[] = [];
    const guard = makeStartupPopupNetworkGuard({
      getSessionRules: async () => [rule(4, [8])],
      updateSessionRules: async (update) => { updates.push(update); },
    }, [4]);
    expect(await guard.adopt(7, 9)).toBe(false);
    expect(guard.hasSourceEvidence(7)).toBe(false);
    expect(updates).toEqual([]);
    expect(guard.tabIds()).toEqual([]);
  });

  test('a partial private-rule set is enforcement evidence but not authority', async () => {
    const updates: any[] = [];
    const guard = makeStartupPopupNetworkGuard({
      getSessionRules: async () => [rule(4, [7])],
      updateSessionRules: async (update) => { updates.push(update); },
    }, [4, 5]);
    await expect(guard.adopt(7, 9))
      .rejects.toThrow('startup-popup-source-evidence-incomplete');
    expect(updates).toEqual([]);
  });

  test('complete private ids with a malformed rule shape are not containment', async () => {
    const malformed = rule(5, [7]);
    delete (malformed.condition as any).resourceTypes;
    const guard = makeStartupPopupNetworkGuard({
      getSessionRules: async () => [rule(4, [7]), malformed],
      updateSessionRules: async () => { throw new Error('must-not-update'); },
    }, [4, 5]);
    await expect(guard.adopt(7, 9))
      .rejects.toThrow('startup-popup-source-evidence-incomplete');
  });

  test('requires canonical private rule semantics when fingerprints are supplied', async () => {
    const canonical = buildPrivateNetworkBlockRules({
      tabIds: [7], resourceTypes: CHROME_DNR_RESOURCE_TYPES,
    }) as any[];
    let exactRules = structuredClone(canonical);
    const exact = makeStartupPopupNetworkGuard({
      getSessionRules: async () => exactRules,
      updateSessionRules: async (update) => {
        exactRules = [
          ...exactRules.filter((candidate: any) => !update.removeRuleIds.includes(candidate.id)),
          ...update.addRules,
        ];
      },
    }, canonical.map((entry) => entry.id), {
      ruleDigests: PRIVATE_NETWORK_RULE_DIGESTS,
    });
    await expect(exact.adopt(7, 9)).resolves.toBe(true);
    for (const [targetId, mutate] of [
      [4, (entry: any) => { entry.condition.requestDomains = ['localhost']; }],
      [5, (entry: any) => { entry.condition.regexFilter = '^https?://127\\.'; }],
      [4, (entry: any) => {
        entry.condition.resourceTypes = entry.condition.resourceTypes
          .filter((type: string) => type !== 'image');
      }],
      [4, (entry: any) => { entry.condition.excludedTabIds = [9]; }],
      [4, (entry: any) => { entry.condition.initiatorDomains = ['source.example']; }],
      [4, (entry: any) => { entry.condition.excludedRequestDomains = ['localhost']; }],
    ] as const) {
      const candidate = structuredClone(canonical.find((entry) => entry.id === targetId));
      mutate(candidate);
      const guard = makeStartupPopupNetworkGuard({
        getSessionRules: async () => [candidate],
        updateSessionRules: async () => { throw new Error('must-not-update'); },
      }, [targetId], {
        ruleDigests: [PRIVATE_NETWORK_RULE_DIGESTS[targetId - 4]],
      });
      await expect(guard.adopt(7, 9)).resolves.toBe(false);
    }
  });

  test('release removes a copied child before numeric id reuse', async () => {
    let rules = [rule(4, [7]), rule(5, [7])];
    const guard = makeStartupPopupNetworkGuard({
      getSessionRules: async () => rules,
      updateSessionRules: async (update) => {
        rules = [
          ...rules.filter((candidate) => !update.removeRuleIds.includes(candidate.id)),
          ...update.addRules,
        ];
      },
    }, [4, 5]);
    expect(await guard.adopt(7, 9)).toBe(true);
    await guard.release(9);
    expect(rules.every((current) => current.condition.tabIds.length === 1
      && current.condition.tabIds[0] === 7)).toBe(true);
    expect(guard.tabIds()).toEqual([]);
  });

  test('seal refuses later adoption and drains admitted work', async () => {
    let finish = () => {};
    const barrier = new Promise<void>((resolve) => { finish = resolve; });
    let rules = [rule(4, [7])];
    const guard = makeStartupPopupNetworkGuard({
      getSessionRules: async () => { await barrier; return rules; },
      updateSessionRules: async (update) => {
        rules = [
          ...rules.filter((candidate) => !update.removeRuleIds.includes(candidate.id)),
          ...update.addRules,
        ];
      },
    }, [4]);
    const admitted = guard.adopt(7, 9);
    const sealing = guard.seal();
    finish();
    expect(await admitted).toBe(true);
    await sealing;
    expect(await guard.adopt(7, 10)).toBe(false);
  });

  test('distinguishes absent proof from a failed or timed-out guard mutation', async () => {
    const absent = makeStartupPopupNetworkGuard({
      getSessionRules: async () => [], updateSessionRules: async () => {},
    }, [4], { timeoutMs: 5 });
    expect(await absent.adopt(7, 9)).toBe(false);

    const rejected = makeStartupPopupNetworkGuard({
      getSessionRules: async () => [rule(4, [7])],
      updateSessionRules: async () => { throw new Error('dnr-down'); },
    }, [4], { timeoutMs: 5 });
    await expect(rejected.adopt(7, 9)).rejects.toThrow('dnr-down');

    const timedOut = makeStartupPopupNetworkGuard({
      getSessionRules: async () => new Promise(() => {}),
      updateSessionRules: async () => {},
    }, [4], { timeoutMs: 5 });
    await expect(timedOut.sourceEvidence(7))
      .rejects.toThrow('startup-popup-rules-read-timeout');
  });

  test('retries a transient initial DNR read without a worker restart', async () => {
    let reads = 0;
    let rules = [rule(4, [7])];
    const guard = makeStartupPopupNetworkGuard({
      getSessionRules: async () => {
        reads += 1;
        if (reads === 1) throw new Error('read-down');
        return rules;
      },
      updateSessionRules: async (update) => {
        rules = [
          ...rules.filter((candidate) => !update.removeRuleIds.includes(candidate.id)),
          ...update.addRules,
        ];
      },
    }, [4]);

    await expect(guard.adopt(7, 9)).rejects.toThrow('read-down');
    await expect(guard.adopt(7, 9)).resolves.toBe(true);
    expect(reads).toBe(3);
  });

  test('cleans an unhanded startup child after seal', async () => {
    let rules = [rule(4, [7])];
    const guard = makeStartupPopupNetworkGuard({
      getSessionRules: async () => rules,
      updateSessionRules: async (update) => {
        rules = [
          ...rules.filter((candidate) => !update.removeRuleIds.includes(candidate.id)),
          ...update.addRules,
        ];
      },
    }, [4]);
    expect(await guard.adopt(7, 9)).toBe(true);
    await guard.seal();
    await guard.release(9);
    expect(rules[0].condition.tabIds).toEqual([7]);
  });

  test('retries failed release and safely admits a reused child id', async () => {
    let failRelease = true;
    let rules = [rule(4, [7])];
    const guard = makeStartupPopupNetworkGuard({
      getSessionRules: async () => rules,
      updateSessionRules: async (update) => {
        if (failRelease && update.addRules[0]?.condition.tabIds.length === 1) {
          throw new Error('release-down');
        }
        rules = [
          ...rules.filter((candidate) => !update.removeRuleIds.includes(candidate.id)),
          ...update.addRules,
        ];
      },
    }, [4], { retryMs: 1 });
    const first = Symbol('first');
    const reused = Symbol('reused');
    expect(await guard.adopt(7, 9, first)).toBe(true);
    await guard.release(9, first);
    failRelease = false;
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(rules[0].condition.tabIds).toEqual([7]);
    expect(await guard.adopt(7, 9, reused)).toBe(true);
    expect(rules[0].condition.tabIds).toEqual([7, 9]);
  });

  test('never reuses failed cleanup as positive source evidence', async () => {
    let failRelease = true;
    let rules = [rule(4, [7])];
    const guard = makeStartupPopupNetworkGuard({
      getSessionRules: async () => rules,
      updateSessionRules: async (update) => {
        if (failRelease && update.addRules[0]?.condition.tabIds.length === 1) {
          throw new Error('release-down');
        }
        rules = [
          ...rules.filter((candidate) => !update.removeRuleIds.includes(candidate.id)),
          ...update.addRules,
        ];
      },
    }, [4], { timeoutMs: 5 });
    expect(await guard.adopt(7, 9)).toBe(true);
    await guard.release(9);
    expect(guard.hasSourceEvidence(9)).toBe(false);
    expect(await guard.adopt(9, 10)).toBe(false);
    failRelease = false;
    await guard.release(9);
    expect(rules[0].condition.tabIds).toEqual([7]);
  });

  test('reconstruction treats a copied numeric id as containment, not authority', async () => {
    let rules = [rule(4, [7, 9]), rule(5, [7, 9])];
    const guard = makeStartupPopupNetworkGuard({
      getSessionRules: async () => rules,
      updateSessionRules: async (update) => {
        rules = [
          ...rules.filter((candidate) => !update.removeRuleIds.includes(candidate.id)),
          ...update.addRules,
        ];
      },
    }, [4, 5]);
    expect(await guard.sourceEvidence(9)).toBe(true);
    expect(await guard.adopt(9, 10)).toBe(true);
    await guard.release(10);
    expect(rules.every((current) => !current.condition.tabIds.includes(10))).toBe(true);
    expect(await guard.sourceEvidence(7)).toBe(true);
  });

  test('release cleans a DNR update that committed before rejecting', async () => {
    let rejectCommit = true;
    let rules = [rule(4, [7]), rule(5, [7])];
    const guard = makeStartupPopupNetworkGuard({
      getSessionRules: async () => rules,
      updateSessionRules: async (update) => {
        rules = [
          ...rules.filter((candidate) => !update.removeRuleIds.includes(candidate.id)),
          ...update.addRules,
        ];
        if (rejectCommit) {
          rejectCommit = false;
          throw new Error('committed-then-rejected');
        }
      },
    }, [4, 5]);
    await expect(guard.adopt(7, 9)).rejects.toThrow('committed-then-rejected');
    await guard.release(9);
    expect(rules.every((current) => !current.condition.tabIds.includes(9))).toBe(true);
  });

  test('release follows and cleans a DNR update that commits after timeout', async () => {
    let finish!: () => void;
    let rules = [rule(4, [7]), rule(5, [7])];
    let first = true;
    const guard = makeStartupPopupNetworkGuard({
      getSessionRules: async () => rules,
      updateSessionRules: async (update) => {
        if (first) {
          first = false;
          await new Promise<void>((resolve) => { finish = resolve; });
        }
        rules = [
          ...rules.filter((candidate) => !update.removeRuleIds.includes(candidate.id)),
          ...update.addRules,
        ];
      },
    }, [4, 5], { timeoutMs: 1 });
    await expect(guard.adopt(7, 9))
      .rejects.toThrow('startup-popup-rule-update-timeout');
    await guard.release(9);
    finish();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(rules.every((current) => !current.condition.tabIds.includes(9))).toBe(true);
  });

  test('seal waits for admitted raw mutations before rich rule ownership', async () => {
    let finish!: () => void;
    let rules = [rule(4, [7])];
    const guard = makeStartupPopupNetworkGuard({
      getSessionRules: async () => rules,
      updateSessionRules: async (update) => {
        await new Promise<void>((resolve) => { finish = resolve; });
        rules = [
          ...rules.filter((candidate) => !update.removeRuleIds.includes(candidate.id)),
          ...update.addRules,
        ];
      },
    }, [4], { timeoutMs: 1 });
    await expect(guard.adopt(7, 9)).rejects.toThrow('startup-popup-rule-update-timeout');
    let sealed = false;
    const sealing = guard.seal().then(() => { sealed = true; });
    await new Promise((resolve) => setTimeout(resolve, 2));
    expect(sealed).toBe(false);
    finish();
    await sealing;
    expect(sealed).toBe(true);
  });

  test('reconstructs and cleans a committed candidate after worker loss', async () => {
    let rules = [rule(4, [7])];
    let pending: {tabId:number,sourceTabId:number}[] = [];
    const dnr = {
      getSessionRules: async () => rules,
      updateSessionRules: async (update: any) => {
        rules = [
          ...rules.filter((candidate) => !update.removeRuleIds.includes(candidate.id)),
          ...update.addRules,
        ];
      },
    };
    const persistence = {
      loadPending: async () => pending,
      savePending: async (rows: {tabId:number,sourceTabId:number}[]) => { pending = [...rows]; },
      retryMs: 1,
    };
    const first = makeStartupPopupNetworkGuard(dnr, [4], persistence);
    expect(await first.adopt(7, 9)).toBe(true);
    expect(pending).toEqual([{ tabId: 9, sourceTabId: 7 }]);

    makeStartupPopupNetworkGuard(dnr, [4], persistence);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(rules[0].condition.tabIds).toEqual([7]);
    expect(pending).toEqual([]);
  });

  test('serializes concurrent candidate persistence snapshots', async () => {
    let rules = [rule(4, [7])];
    const saves: {tabId:number,sourceTabId:number}[][] = [];
    let releaseFirst!: () => void;
    const firstSave = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let writes = 0;
    const guard = makeStartupPopupNetworkGuard({
      getSessionRules: async () => rules,
      updateSessionRules: async (update) => {
        rules = [
          ...rules.filter((candidate) => !update.removeRuleIds.includes(candidate.id)),
          ...update.addRules,
        ];
      },
    }, [4], {
      savePending: async (rows) => {
        writes += 1;
        if (writes === 1) await firstSave;
        saves.push([...rows]);
      },
    });
    const first = guard.adopt(7, 9);
    await Promise.resolve();
    await Promise.resolve();
    const second = guard.adopt(7, 10);
    releaseFirst();
    await Promise.all([first, second]);
    expect(saves).toEqual([
      [{ tabId: 9, sourceTabId: 7 }],
      [{ tabId: 9, sourceTabId: 7 }, { tabId: 10, sourceTabId: 7 }],
    ]);
  });

  test('keeps an exact live recovered child guarded until source classification', async () => {
    let rules = [rule(4, [7, 9])];
    let pending = [{ tabId: 9, sourceTabId: 7 }];
    const guard = makeStartupPopupNetworkGuard({
      getSessionRules: async () => rules,
      updateSessionRules: async (update) => {
        rules = [
          ...rules.filter((candidate) => !update.removeRuleIds.includes(candidate.id)),
          ...update.addRules,
        ];
      },
    }, [4], {
      loadPending: async () => pending,
      savePending: async (rows) => { pending = [...rows]; },
      loadTabs: async () => [
        { id: 7 }, { id: 9, openerTabId: 7 },
      ],
      retryMs: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 2));
    expect(guard.tabIds()).toEqual([9]);
    expect(rules[0].condition.tabIds).toEqual([7, 9]);
    await guard.reconcileSources(() => true);
    expect(rules[0].condition.tabIds).toEqual([7, 9]);
    await guard.reconcileSources(() => false);
    expect(rules[0].condition.tabIds).toEqual([7]);
  });

  test('retries a failed cleanup-ledger read before numeric reuse', async () => {
    let rules = [rule(4, [7, 9])];
    let reads = 0;
    let pending = [{ tabId: 9, sourceTabId: 7 }];
    makeStartupPopupNetworkGuard({
      getSessionRules: async () => rules,
      updateSessionRules: async (update) => {
        rules = [
          ...rules.filter((candidate) => !update.removeRuleIds.includes(candidate.id)),
          ...update.addRules,
        ];
      },
    }, [4], {
      loadPending: async () => {
        reads += 1;
        if (reads === 1) throw new Error('storage-transient');
        return pending;
      },
      savePending: async (rows) => { pending = [...rows]; },
      loadTabs: async () => [{ id: 7 }],
      retryMs: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 8));
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(rules[0].condition.tabIds).toEqual([7]);
    expect(pending).toEqual([]);
  });

  test('tombstones removal before a stale restoration snapshot settles', async () => {
    let rules = [rule(4, [7, 9])];
    let settlePending!: (rows: {tabId:number,sourceTabId:number}[]) => void;
    const pending = new Promise<{tabId:number,sourceTabId:number}[]>((resolve) => {
      settlePending = resolve;
    });
    const guard = makeStartupPopupNetworkGuard({
      getSessionRules: async () => rules,
      updateSessionRules: async (update) => {
        rules = [
          ...rules.filter((candidate) => !update.removeRuleIds.includes(candidate.id)),
          ...update.addRules,
        ];
      },
    }, [4], {
      loadPending: () => pending,
      savePending: async () => {},
      loadTabs: async () => [{ id: 7 }, { id: 9, openerTabId: 7 }],
    });
    const removal = guard.release(9);
    settlePending([{ tabId: 9, sourceTabId: 7 }]);
    await removal;
    expect(guard.tabIds()).toEqual([]);
    expect(guard.isGuarded(9)).toBe(false);
    expect(rules[0].condition.tabIds).toEqual([7]);
  });

  test('a missing cleanup ledger becomes an empty restored generation', async () => {
    let rules = [rule(4, [7])];
    let pending: {tabId:number,sourceTabId:number}[] | undefined;
    const guard = makeStartupPopupNetworkGuard({
      getSessionRules: async () => rules,
      updateSessionRules: async (update) => {
        rules = [
          ...rules.filter((candidate) => !update.removeRuleIds.includes(candidate.id)),
          ...update.addRules,
        ];
      },
    }, [4], {
      loadPending: async () => pending,
      savePending: async (rows) => { pending = [...rows]; },
      loadTabs: async () => [{ id: 7 }],
    });
    const generation = Symbol('child-generation');
    await expect(guard.adopt(7, 9, generation)).resolves.toBe(true);
    await guard.release(9, generation);
    expect(pending).toEqual([]);
    expect(rules[0].condition.tabIds).toEqual([7]);
    expect(guard.tabIds()).toEqual([]);
  });

  test('never reports custody after a later rule writer strips the child', async () => {
    let rules = [rule(4, [7])];
    let mutationStarted!: () => void;
    let releaseMutation!: () => void;
    const started = new Promise<void>((resolve) => { mutationStarted = resolve; });
    const held = new Promise<void>((resolve) => { releaseMutation = resolve; });
    const guard = makeStartupPopupNetworkGuard({
      getSessionRules: async () => rules,
      updateSessionRules: async (update) => {
        rules = [
          ...rules.filter((candidate) => !update.removeRuleIds.includes(candidate.id)),
          ...update.addRules,
        ];
        mutationStarted();
        await held;
        rules = [rule(4, [7])];
      },
    }, [4]);
    const adopted = guard.adopt(7, 9);
    await started;
    expect(guard.tabIds()).toEqual([9]);
    releaseMutation();
    await expect(adopted).rejects.toThrow('startup-popup-rule-update-unverified');
    expect(guard.isGuarded(9)).toBe(false);
  });
});
