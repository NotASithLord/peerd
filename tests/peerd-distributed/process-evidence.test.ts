import {expect,test} from 'bun:test';
import {cpuTimeMs,processTreeSample} from '../../scripts/cdp/dweb-process-evidence.mjs';

test('process evidence includes browser descendants and excludes unrelated work',()=>{
 const sample=processTreeSample('10 1 100 00:01.50\n11 10 200 01:02.00\n12 11 300 00:03.00\n99 1 9999 10:00.00',10);
 expect(sample.processes.map(p=>p.pid)).toEqual([10,11,12]);
 expect(sample.summedRssBytes).toBe(600*1024);
 expect(sample.observedCpuTimeMs).toBe(66500);
 expect(sample.processCount).toBe(3);
});
test('CPU time parses cumulative minutes and days without treating them as percentages',()=>{
 expect(cpuTimeMs('121:02.50')).toBe(7262500);
 expect(cpuTimeMs('1-02:03:04')).toBe(93784000);
 for(const value of ['1:99','bad','1-02:03','00:99:00'])expect(()=>cpuTimeMs(value)).toThrow();
});
test('missing or malformed process evidence never becomes a zero-resource sample',()=>{
 for(const text of ['', '11 1 10 00:00', '10 1 bad 00:00','10 1 10 00:00\n10 1 10 00:00'])expect(()=>processTreeSample(text,10)).toThrow();
});
