// @ts-check
// Commands store — the peerd workspace `.peerd/commands/` surface.
//
// peerd has no real filesystem, so a "command file" is a record in the
// workspace store. Each command is a name (kebab) + a markdown body. The
// user (or a skill, via the 07 adapter) authors them; `/name` in the
// composer resolves to the body.
//
// Storage: we key small command bodies in the injected KV
// (chrome.storage.local) under a flat prefix. Markdown command files are
// tiny (a few KB) and well under the KV record budget, and KV gives us a
// trivially mockable, structured-clone-safe seam for tests. Larger
// workspace surfaces (App bodies, VM disks) live in OPFS/IDB; commands
// don't need that weight. If a future workspace wants real directories,
// swap the backend here without touching parse/resolve/palette.
//
// Functional-core/imperative-shell: this file is the shell. The KV is
// injected (never imported), so the store is testable with an in-memory
// stub. No business logic lives here beyond key namespacing + shape.

// why: one prefix so list() is a single KV range scan and we never
// collide with other features' keys. Mirrors the `.peerd/commands/`
// path the user thinks in.
export const COMMAND_KEY_PREFIX = 'peerd.commands.';

/** @param {string} name */
const keyFor = (name) => `${COMMAND_KEY_PREFIX}${name}`;

// Command names map 1:1 to `.peerd/commands/<name>.md`. Constrain to the
// same charset the parser accepts so a stored command is always callable.
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

/** @param {string} name @returns {boolean} */
export const isValidCommandName = (name) =>
  typeof name === 'string' && NAME_RE.test(name);

/**
 * @typedef {Object} CommandRecord
 * @property {string} name
 * @property {string} body        markdown
 * @property {string} [description]   short one-liner for the palette detail
 * @property {number} [updatedAt]
 */

/**
 * Build a command store over an injected KV.
 *
 * @param {{ kv: import('/peerd-egress/storage/kv.js').KV, now?: () => number }} deps
 */
export const createCommandStore = ({ kv, now = Date.now }) => {
  if (!kv) throw new Error('createCommandStore: kv is required');

  /**
   * List every stored command, name-sorted. Bodies are included — the
   * list is small and the palette wants the body ready on Enter.
   * @returns {Promise<CommandRecord[]>}
   */
  const list = async () => {
    const all = await kv.list(COMMAND_KEY_PREFIX);
    return Object.values(all)
      .filter((r) => r && typeof r.name === 'string')
      .sort((a, b) => a.name.localeCompare(b.name));
  };

  /**
   * Fetch one command by name. Returns null when absent.
   * @param {string} name
   * @returns {Promise<CommandRecord|null>}
   */
  const get = async (name) => {
    if (!isValidCommandName(name)) return null;
    const r = await kv.get(keyFor(name));
    return r ?? null;
  };

  /**
   * Create or overwrite a command.
   * @param {{ name: string, body: string, description?: string }} rec
   * @returns {Promise<CommandRecord>}
   */
  const put = async ({ name, body, description }) => {
    if (!isValidCommandName(name)) {
      throw new Error(`invalid command name: ${name}`);
    }
    if (typeof body !== 'string') throw new Error('command body must be a string');
    const rec = { name, body, description: description ?? '', updatedAt: now() };
    await kv.set(keyFor(name), rec);
    return rec;
  };

  /**
   * Delete a command. Idempotent.
   * @param {string} name
   */
  const remove = async (name) => {
    if (!isValidCommandName(name)) return;
    await kv.delete(keyFor(name));
  };

  return { list, get, put, remove };
};
