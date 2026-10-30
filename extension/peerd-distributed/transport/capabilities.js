// @ts-check
// why: signed HELLO capabilities negotiate optional protocols on this exact
// authenticated carrier; unknown capabilities remain compatible with old peers.
export const TOPIC_SYNC_WINDOW = 'topic-sync-window-v1';

// Temporary carriers grant content exchange only, never routing authority.
export const CONTENT_ONLY = 'content-only-v1';

// Temporary directory RPC carrier, independent from content and routing roles.
export const LOOKUP_ONLY = 'lookup-only-v1';

// Routing-path queries and holds use existing carriers only. Advertising this
// capability requires a live per-room protocol owner; it is not enabled merely
// by importing these constants.
export const ROUTING_WITNESS = 'routing-witness-v1';
export const ROUTING_CONTROL = Object.freeze({ROUTE_CALL:10,ROUTE_REPLY:11,ROUTE_CANCEL:12});

// Immutable retrieval over existing routing links has no witness/rotation authority.
export const ROUTED_RETRIEVAL = 'routed-retrieval-v1';
export const RETRIEVAL_CHANNEL = 6;
export const RETRIEVAL_TYPES = Object.freeze({CALL:0,PART:1,ACK:2,CANCEL:3});
