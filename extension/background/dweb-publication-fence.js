// @ts-check
// Serialize dweb publication work and invalidate requests that crossed master OFF.

export const createDwebPublicationFence = () => {
  let generation = 0;
  let tail = Promise.resolve();

  const invalidate = () => { generation += 1; return generation; };

  /**
   * @template T
   * @param {(isCurrent: () => boolean) => Promise<T>} operation
   * @returns {Promise<T>}
   */
  const run = (operation) => {
    const requestedGeneration = generation;
    const execute = () => operation(() => requestedGeneration === generation);
    const result = tail.then(execute, execute);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };

  return Object.freeze({ run, invalidate, generation: () => generation });
};
