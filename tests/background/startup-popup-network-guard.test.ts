import { describe, expect, test } from 'bun:test';
import { makeStartupPopupNetworkGuard } from '../../extension/background/startup-popup-network-guard.js';

const rule = (id: number, tabIds: number[], action = 'block') => ({
  id, priority: 4, action: { type: action },
  condition: { tabIds, resourceTypes: ['main_frame'] },
});

describe('startup popup network guard', () => {
  test('copies only block rules proving ownership of the exact source', async () => {
    let rules = [rule(4, [7, 8]), rule(5, [7, 8]), rule(6, [7]), rule(2, [7], 'allow')];
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
    expect(updates[0].removeRuleIds).toEqual([4, 5]);
    expect(updates[0].addRules[0].condition.tabIds).toEqual([7, 8, 9]);
    expect(guard.tabIds()).toEqual([9]);
  });

  test('absent source proof changes nothing', async () => {
    const updates: any[] = [];
    const guard = makeStartupPopupNetworkGuard({
      getSessionRules: async () => [rule(4, [8])],
      updateSessionRules: async (update) => { updates.push(update); },
    }, [4]);
    expect(await guard.adopt(7, 9)).toBe(false);
    expect(updates).toEqual([]);
    expect(guard.tabIds()).toEqual([]);
  });

  test('a partial private-rule set is enforcement evidence but not authority', async () => {
    const updates: any[] = [];
    const guard = makeStartupPopupNetworkGuard({
      getSessionRules: async () => [rule(4, [7])],
      updateSessionRules: async (update) => { updates.push(update); },
    }, [4, 5]);
    expect(await guard.adopt(7, 9)).toBe(false);
    expect(updates).toEqual([]);
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
    const guard = makeStartupPopupNetworkGuard({
      getSessionRules: async () => { await barrier; return [rule(4, [7])]; },
      updateSessionRules: async () => {},
    }, [4]);
    const admitted = guard.adopt(7, 9);
    const sealing = guard.seal();
    finish();
    expect(await admitted).toBe(true);
    await sealing;
    expect(await guard.adopt(7, 10)).toBe(false);
  });
});
