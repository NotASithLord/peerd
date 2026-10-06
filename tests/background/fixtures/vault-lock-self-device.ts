import { mock } from 'bun:test';
const root = process.cwd();
(globalThis as any).chrome.runtime.sendMessage = async () => ({});
const load = (p: string) => import(`${root}/extension/${p}`);
const { generateIdentity } = await load('peerd-distributed/identity/keypair.js');
const { issueDeviceCertificate, buildDeviceRoster } = await load('peerd-distributed/identity/device-certificate.js');
const { createSelfDeviceCoordinator } = await load('peerd-distributed/self/coordinator.js');
const { createSelfDeviceMesh } = await load('peerd-distributed/self/mesh.js');
const { memoryPair } = await load('peerd-distributed/transport/channel.js');
const { makeVaultRoutes } = await load('background/routes/vault.js');
const person = await generateIdentity();
const device = await generateIdentity();
const deviceCert = await issueDeviceCertificate({ personIdentity: person, deviceDid: device.did, deviceId: 'proof-device', label: 'Proof', now: 1, seq: 1 });
const roster = await buildDeviceRoster({ personIdentity: person, devices: [{ deviceDid: device.did, deviceId: 'proof-device', addedAt: 1, status: 'active' }], seq: 1 });
let entered!: () => void;
const firstHello = new Promise<void>(resolve => { entered = resolve; });
let closeFirst!: () => void;
let dials = 0;
class WS {
  readyState = 1; onmessage: any; onclose: any; onerror: any;
  constructor() { queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ t: 'room', self: 'me', members: ['silent-peer'] }) })); }
  send() {}
  close() { this.readyState = 3; this.onclose?.(); }
}
const client = {
  available: true, defaultSignaling: ['ws://proof.invalid/'],
  loadCoordinatorInputs: async () => ({ personDid: person.did, deviceIdentity: device, deviceCert, roster, discoverySecret: new Uint8Array(32).fill(7) }),
  createSelfDeviceCoordinator,
  createSelfDeviceMesh: (options: any) => createSelfDeviceMesh({ ...options, WebSocket: WS, transport: {
    connect: async () => {
      const [a,b] = memoryPair();
      const n = ++dials;
      b.setHandler((message: any) => {
        if (message.__t !== 'HELLO') return;
        if (n === 1) { closeFirst = () => b.close(); entered(); }
        else b.close();
      });
      return a;
    },
  } }),
};
mock.module(`${root}/extension/shared/dweb-loader.js`, () => ({ loadDweb: async () => client }));
const { createSelfDeviceHost } = await load('offscreen/dweb-self.js');
const host = createSelfDeviceHost({ secretIo: {}, swCall: async () => ({ok:true}), getSignalingUrl: () => 'ws://proof.invalid/' });
let startSettled = false, lockSettled = false, authorityLocked = false;
let startResult: any;
void host.start().then((value: any) => { startSettled = true; startResult = value; }, (error: any) => { startSettled = true; startResult = { error: error.message }; });
await firstHello;
let stopping!: () => void;
const stopEntered = new Promise<void>(resolve => { stopping = resolve; });
const route = makeVaultRoutes({ vault: { lock: async () => { authorityLocked = true; } }, onLocked: () => { const result = host.stop(); stopping(); return result; }, auditLog: { append: async () => {} }, pushState: () => {} });
const locking = route['vault/lock']().then(() => { lockSettled = true; });
await stopEntered;
closeFirst();
let watchdog: ReturnType<typeof setTimeout>;
await Promise.race([locking, new Promise(resolve => { watchdog = setTimeout(resolve, 5_000); })]);
clearTimeout(watchdog!);
console.log('SELF_LOCK_RESULT:' + JSON.stringify({ authorityLocked, startSettled, lockSettled, dials, startResult }));
// A child process isolates loader mocking from the rest of the functional suite.
// Failure exits also contain the old implementation's abandoned room timers.
process.exit(lockSettled ? 0 : 2);
