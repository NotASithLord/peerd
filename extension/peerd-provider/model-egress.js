// @ts-check
// Controller-facing model authority contract.
//
// Provider adapters own semantic request bodies, retry decisions, stream
// decoding, and response interpretation. The injected authority owns fixed
// destinations, credentials, authentication, network policy, and resident
// local-engine custody. Keeping those effects named prevents a provider from
// smuggling an arbitrary URL, header, storage key, or fetch option across the
// controller boundary.

/**
 * @typedef {Object} ModelEgress
 * @property {(args: {
 *   providerId: string,
 *   modelId: string,
 *   nativeBody: object,
 *   signal?: AbortSignal,
 * }) => Promise<Response>} openInference
 * @property {(args: {
 *   providerId: string,
 *   signal?: AbortSignal,
 * }) => Promise<Response>} readModelInventory
 * @property {(args: {
 *   providerId: string,
 *   modelId: string,
 *   signal?: AbortSignal,
 * }) => Promise<Response>} readModelContext
 * @property {(args: {
 *   providerId: string,
 *   modelId: string,
 *   messages: readonly object[],
 *   system: string,
 *   tools?: readonly object[],
 *   maxTokens: number,
 *   signal?: AbortSignal,
 * }) => AsyncIterable<string>} generateLocal
 */

export {};
