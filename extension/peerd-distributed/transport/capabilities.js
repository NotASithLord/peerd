// @ts-check
// why: signed HELLO capabilities negotiate optional protocols on this exact
// authenticated carrier; unknown capabilities remain compatible with old peers.
export const TOPIC_SYNC_WINDOW = 'topic-sync-window-v1';

// Temporary carriers grant content exchange only, never routing authority.
export const CONTENT_ONLY = 'content-only-v1';

// Temporary directory RPC carrier, independent from content and routing roles.
export const LOOKUP_ONLY = 'lookup-only-v1';
