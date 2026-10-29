// Numeric OS process observations only: never retain command lines or arguments.
export const cpuTimeMs = value => {
  const match = /^(?:(\d+)-)?(\d+):(\d{2})(?::(\d{2}))?(?:\.(\d+))?$/.exec(value);
  if (!match) throw new Error('Invalid process CPU time');
  const days = Number(match[1] ?? 0);
  const hours = match[4] === undefined ? 0 : Number(match[2]);
  const minutes = Number(match[4] === undefined ? match[2] : match[3]);
  const seconds = Number(match[4] === undefined ? match[3] : match[4]);
  if (seconds >= 60 || (match[4] !== undefined && minutes >= 60) || (match[1] && match[4] === undefined)) throw new Error('Invalid process CPU time');
  const result = ((days * 24 + hours) * 3600 + minutes * 60 + seconds + Number(`0.${match[5] ?? 0}`)) * 1000;
  if (!Number.isFinite(result) || result > Number.MAX_SAFE_INTEGER) throw new Error('Invalid process CPU time');
  return result;
};

export const processTreeSample = (text, rootPid) => {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0) throw new Error('Invalid browser PID');
  const rows = new Map();
  for (const line of text.trim().split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
    if (!match) throw new Error('Malformed process observation');
    const [pid, parentPid, rssKiB] = match.slice(1, 4).map(Number);
    if (![pid, parentPid, rssKiB].every(Number.isSafeInteger) || pid <= 0 || rows.has(pid) || !Number.isSafeInteger(rssKiB * 1024)) throw new Error('Invalid process observation');
    rows.set(pid, {pid, parentPid, rssBytes:rssKiB * 1024, cpuTimeMs:cpuTimeMs(match[4])});
  }
  if (!rows.has(rootPid)) throw new Error('Browser process absent from observation');
  const children = new Map();
  for (const row of rows.values()) {
    const group = children.get(row.parentPid) ?? [];
    group.push(row.pid); children.set(row.parentPid, group);
  }
  const owned = new Set([rootPid]);
  for (const pid of owned) for (const child of children.get(pid) ?? []) owned.add(child);
  const processes = [...owned].map(pid => rows.get(pid)).sort((a, b) => a.pid - b.pid);
  return {rootPid, processCount:processes.length, processes,
    // RSS sums can count shared pages more than once; this is not physical RAM.
    summedRssBytes:processes.reduce((sum, row) => sum + row.rssBytes, 0),
    observedCpuTimeMs:processes.reduce((sum, row) => sum + row.cpuTimeMs, 0)};
};
