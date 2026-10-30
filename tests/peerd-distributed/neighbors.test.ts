import { expect, test } from 'bun:test';
import { RoutingAdmissionBusyError } from '../../extension/peerd-distributed/transport/neighbor-policy.js';
import { createNeighborMaintenance, NEIGHBOR_CANDIDATES } from '../../extension/peerd-distributed/transport/neighbors.js';

const fixture = () => {
  let now = 0, next = 0; const tasks = new Map<number, () => void>();
  const timers = { setTimeout(fn: () => void) { tasks.set(++next, fn); return next; }, clearTimeout(id: number) { tasks.delete(id); } };
  return { timers, tasks, now: () => now, advance: () => { now += 20_000; for (const [id, fn] of [...tasks]) { tasks.delete(id); fn(); } } };
};

test('maintenance coalesces pressure, bounds candidates/work and cancels owned dials', async () => {
  const f = fixture(); const ac = new AbortController(); const signals: AbortSignal[] = [];
  const owner = createNeighborMaintenance({ initial: Array.from({ length: 100 }, (_, i) => `peer-${i}`),
    sample: async () => [], known: () => false, localCount: () => 0,
    connect: (_member, signal) => new Promise<void>((_resolve, reject) => { signals.push(signal); signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }); }),
    signal: ac.signal, now: f.now, timers: f.timers, random: () => 0 });
  const started = owner.start(); for (let i = 0; i < 100; i++) owner.wake();
  expect(signals).toHaveLength(4); expect(owner.stats().candidates).toBe(NEIGHBOR_CANDIDATES); expect(f.tasks.size).toBe(0);
  owner.stop(); await started;
  expect(signals.every(signal => signal.aborted)).toBe(true);
  expect(owner.stats()).toEqual({ candidates: 0, running: false, stopped: true }); expect(f.tasks.size).toBe(0);
});

test('late sample completion after retirement cannot dial, retain candidates or schedule another timer', async () => {
  const f = fixture(); const ac = new AbortController(); const reply = Promise.withResolvers<string[]>();
  let dialed = 0; let sampleSignal: AbortSignal | undefined;
  const owner = createNeighborMaintenance({ initial: [], sample: ({ signal }) => { sampleSignal = signal; return reply.promise; },
    known: () => false, localCount: () => 0, connect: async () => { dialed++; },
    signal: ac.signal, now: f.now, timers: f.timers, random: () => 0 });
  await owner.start(); f.advance();
  expect(sampleSignal).toBeDefined(); ac.abort(); reply.resolve(['late']);
  await Promise.resolve(); await Promise.resolve();
  expect(sampleSignal!.aborted).toBe(true); expect(dialed).toBe(0);
  expect(owner.stats()).toEqual({ candidates: 0, running: false, stopped: true }); expect(f.tasks.size).toBe(0);
});

test('failed early contacts do not crowd out untried sampled peers', async () => {
  const f = fixture(); const ac = new AbortController(); let clock = 0;
  const members = Array.from({ length: 12 }, (_, i) => `peer-${i}`);
  const contacted: string[] = []; const linked = new Set<string>();
  const owner = createNeighborMaintenance({ initial: members, sample: async () => members,
    known: member => linked.has(member), localCount: () => linked.size,
    connect: async member => {
      contacted.push(member);
      if (members.slice(0, 4).includes(member)) throw new Error('remote full');
      linked.add(member);
    }, signal: ac.signal, now: () => clock, timers: f.timers, random: () => 0 });
  try {
    await owner.start();
    expect(contacted).toEqual(members.slice(0, 4));
    clock = 20_000; // Early failures are eligible again; sample repeats their order.
    await owner.start();
    expect(contacted.slice(4)).toEqual(members.slice(4, 8));
    expect(linked.size).toBe(4);
  } finally { owner.stop(); }
  expect(f.tasks.size).toBe(0);
});

test('a slow dial does not add another full sampling interval after it settles', async () => {
  let now = 0, next = 0, active = 0, peak = 0;
  const tasks = new Map<number, { fn: () => void; delay: number }>();
  const timers = {
    setTimeout(fn: () => void, delay: number) { tasks.set(++next, { fn, delay }); return next; },
    clearTimeout(id: number) { tasks.delete(id); },
  };
  const slow = Promise.withResolvers<void>();
  const linked = new Set<string>();
  const contacted: string[] = [];
  let samples = 0;
  const owner = createNeighborMaintenance({ initial: ['departed'],
    sample: async () => { samples++; return ['returning']; },
    known: member => linked.has(member), localCount: () => linked.size,
    connect: async member => {
      contacted.push(member); active++; peak = Math.max(peak, active);
      try { if (member === 'departed') await slow.promise; else linked.add(member); }
      finally { active--; }
    }, signal: new AbortController().signal, now: () => now, timers, random: () => 0 });
  try {
    const started = owner.start();
    now = 15_000;
    expect(tasks.size).toBe(0); // No overlapping cycle while the dial owns work.
    slow.reject(new Error('departed contact timed out'));
    await started;
    expect([...tasks.values()].map(task => task.delay)).toEqual([0]);
    await owner.start(); // Execute the due cycle without advancing simulated time.
    expect(samples).toBe(1);
    expect(contacted).toEqual(['departed', 'returning']); // Failed contact keeps its backoff.
    expect(linked.has('returning')).toBe(true);
    expect(peak).toBe(1);
    expect([...tasks.values()].map(task => task.delay)).toEqual([10_000]);
  } finally { owner.stop(); }
  expect(tasks.size).toBe(0);
});

for (const local of [true, false]) test(`only locally owned admission pressure avoids extra remote failure debt (${local})`, async () => {
  let now=0, calls=0;
  const owner=createNeighborMaintenance({initial:['peer'],sample:async()=>[],known:()=>false,localCount:()=>0,
    now:()=>now,random:()=>0,timers:{setTimeout:()=>1,clearTimeout:()=>{}},signal:new AbortController().signal,
    connect:async()=>{calls++; if(local)throw new RoutingAdmissionBusyError();
      throw Object.assign(new Error('room admission reservation refused'),{name:'RoutingAdmissionBusyError'});}});
  try {
    for(let step=0;step<6;step++){now=step*10000;await owner.start();}
    expect(calls).toBe(local?6:4);
  } finally {owner.stop();}
});

test('local admission pressure preserves already accumulated remote failure debt', async () => {
 let now=0;const calls:number[]=[];
 const owner=createNeighborMaintenance({initial:['peer'],sample:async()=>[],known:()=>false,localCount:()=>0,
  now:()=>now,random:()=>0,timers:{setTimeout:()=>1,clearTimeout:()=>{}},signal:new AbortController().signal,
  connect:async()=>{calls.push(now);if(now===20000)throw new RoutingAdmissionBusyError();throw new Error('remote failed');}});
 try {
  for(let step=0;step<6;step++){now=step*10000;await owner.start();}
  expect(calls).toEqual([0,10000,20000,30000,50000]);
 }finally{owner.stop();}
});

test('routing capacity serializes the first dial then unlocks bounded parallel work', async () => {
 let limit=1,active=0,peak=0;const pending=new Map<string,ReturnType<typeof Promise.withResolvers<void>>>();
 const owner=createNeighborMaintenance({initial:['a','b','c','d'],sample:async()=>[],known:()=>false,localCount:()=>0,
  parallelism:()=>limit,now:()=>0,random:()=>0,timers:{setTimeout:()=>1,clearTimeout:()=>{}},signal:new AbortController().signal,
  connect:async member=>{active++;peak=Math.max(peak,active);const done=Promise.withResolvers<void>();pending.set(member,done);try{await done.promise;}finally{active--;}}});
 try {
  const started=owner.start();expect([...pending.keys()]).toEqual(['a']);expect(peak).toBe(1);
  limit=3;pending.get('a')!.resolve();await new Promise<void>(resolve=>setImmediate(resolve));
  expect([...pending.keys()]).toEqual(['a','b','c','d']);expect(peak).toBe(3);
  for(const done of pending.values())done.resolve();await started;expect(active).toBe(0);
 }finally{owner.stop();}
});

test('a capacity-limited round resamples after a slow contact before spending another stale deadline', async () => {
 let now=0,samples=0;const calls:string[]=[];const first=Promise.withResolvers<void>();const delays:number[]=[];
 const owner=createNeighborMaintenance({initial:['stale-a','stale-b','stale-c'],sample:async()=>{samples++;return ['fresh'];},
  known:()=>false,localCount:()=>0,parallelism:()=>1,now:()=>now,random:()=>0,
  timers:{setTimeout:(_fn:()=>void,ms:number)=>{delays.push(ms);return 1;},clearTimeout:()=>{}},signal:new AbortController().signal,
  connect:async member=>{calls.push(member);if(member==='stale-a')await first.promise;}});
 try {
  const started=owner.start();now=15000;first.reject(new Error('transport timed out'));await started;
  expect(calls).toEqual(['stale-a']);expect(delays).toEqual([0]);
  await owner.start();expect(samples).toBe(1);expect(calls).toEqual(['stale-a','stale-b','stale-c','fresh']);
 }finally{owner.stop();}
});

test('stopping a capacity-limited round retires its active dial without starting queued contacts', async () => {
 const calls:string[]=[];const timers=new Map<number,()=>void>();
 const owner=createNeighborMaintenance({initial:['a','b','c'],sample:async()=>[],known:()=>false,localCount:()=>0,parallelism:()=>1,
  timers:{setTimeout:(fn:()=>void)=>{timers.set(1,fn);return 1;},clearTimeout:(id:number)=>{timers.delete(id);}},signal:new AbortController().signal,
  connect:(member,signal)=>new Promise<void>((_resolve,reject)=>{calls.push(member);signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true});})});
 const started=owner.start();expect(calls).toEqual(['a']);owner.stop();await started;
 expect(calls).toEqual(['a']);expect(owner.stats()).toEqual({candidates:0,running:false,stopped:true});expect(timers.size).toBe(0);
});
