// @ts-check
// Host-neutral description of one isolated computation. This is data, not an
// authority token: each host still derives and enforces its own live grants.

export const EXECUTION_PROTOCOL = 1;
export const AGENT_PROGRAM = 'agent';
export const JAVASCRIPT_PROGRAM = 'javascript';

/** @typedef {{ kind: string, [key: string]: unknown }} ExecutionProgram */
/**
 * @typedef {Readonly<{
 *   protocol: number,
 *   id: string,
 *   program: Readonly<ExecutionProgram>,
 *   input: unknown,
 *   state: unknown,
 *   capabilities: readonly string[],
 *   metadata: Readonly<Record<string, unknown>>,
 * }>} ExecutionDescription
 */

/**
 * Build the cloneable description shared by execution hosts. Executable
 * implementations remain local to the host; `program.kind` selects one.
 *
 * @param {{
 *   id: string,
 *   program: ExecutionProgram,
 *   input?: unknown,
 *   state?: unknown,
 *   capabilities?: readonly string[],
 *   metadata?: Record<string, unknown>,
 * }} value
 * @returns {ExecutionDescription}
 */
export const describeExecution = ({
  id,
  program,
  input = null,
  state = null,
  capabilities = [],
  metadata = {},
}) => {
  if (typeof id !== 'string' || !id) throw new TypeError('execution id must be a non-empty string');
  if (!program || typeof program !== 'object'
      || typeof program.kind !== 'string' || !program.kind) {
    throw new TypeError('execution program.kind must be a non-empty string');
  }
  if (!Array.isArray(capabilities)
      || capabilities.some((capability) => typeof capability !== 'string' || !capability)) {
    throw new TypeError('execution capabilities must be non-empty strings');
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new TypeError('execution metadata must be an object');
  }
  return Object.freeze({
    protocol: EXECUTION_PROTOCOL,
    id,
    program: Object.freeze({ ...program }),
    input,
    state,
    capabilities: Object.freeze([...new Set(capabilities)]),
    metadata: Object.freeze({ ...metadata }),
  });
};

/** @param {unknown} value @returns {value is ExecutionDescription} */
export const isExecutionDescription = (value) => {
  const execution = /** @type {Partial<ExecutionDescription> | null} */ (value);
  return execution?.protocol === EXECUTION_PROTOCOL
    && typeof execution.id === 'string' && execution.id.length > 0
    && !!execution.program && typeof execution.program === 'object'
    && typeof execution.program.kind === 'string' && execution.program.kind.length > 0
    && Array.isArray(execution.capabilities)
    && execution.capabilities.every((capability) => typeof capability === 'string' && capability.length > 0)
    && !!execution.metadata && typeof execution.metadata === 'object'
    && !Array.isArray(execution.metadata);
};
