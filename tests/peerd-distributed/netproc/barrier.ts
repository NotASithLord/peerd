// Trusted test coordination only: no production signaling or mesh authority.
// All nodes must reach each stage before a faster node can advance or retire.
export const createBarrier = (participants: number) => {
  if (!Number.isSafeInteger(participants) || participants < 2 || participants > 65) {
    throw new Error('Expected 2..65 test participants');
  }
  const stages = ['ready', 'published', 'complete'];
  const members = new Map<string, number>();
  const arrived = stages.map(() => new Set<string>());
  let released = -1;
  let failed = false;
  return {
    join(id: string) {
      if (failed || !id || members.has(id) || members.size >= participants || released >= 0) return false;
      members.set(id, -1);
      return true;
    },
    leave(id: string) {
      // A missing participant cannot turn a full-cluster gate into quorum-only.
      if (members.has(id) && released < stages.length - 1) failed = true;
    },
    arrive(id: string, stage: string) {
      const index = stages.indexOf(stage);
      if (failed || !members.has(id) || index < 0 || index !== members.get(id)! + 1 || index > released + 1) return false;
      members.set(id, index);
      arrived[index]!.add(id);
      if (members.size === participants && arrived[index]!.size === participants) {
        released = index;
        return true;
      }
      return false;
    },
  };
};
