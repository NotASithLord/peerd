// @ts-check
// why: diagnostics must have fixed memory cost even under identity/topic churn.
// Counters saturate, never allocate names from traffic, and expose copies only.
/** @template {string} T
 * @param {T[]} names */
export const createLocalCounters = (names) => {
  /** @type {Record<string, number>} */
  const values = Object.fromEntries(names.map(name => [name, 0]));
  return {
    /** @param {string} name @param {number} [amount] */
    add(name, amount = 1) {
      if (Object.hasOwn(values, name) && Number.isSafeInteger(amount) && amount >= 0) {
        values[name] = Math.min(Number.MAX_SAFE_INTEGER, values[name] + amount);
      }
    },
    /** @param {string} name @param {number} value */
    max(name, value) {
      if (Object.hasOwn(values, name) && Number.isSafeInteger(value) && value >= 0) values[name] = Math.max(values[name], value);
    },
    snapshot: () => /** @type {Record<T, number>} */ ({ ...values }),
  };
};
