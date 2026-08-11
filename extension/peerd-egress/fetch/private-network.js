// @ts-check
// Compatibility re-export. The pure policy lives in shared so browser
// automation, document readers, and open-web egress use one implementation.

export { isCloudMetadataHost, isPrivateOrLocalHost } from '../../shared/private-network.js';
