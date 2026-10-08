// why: only a positive integer issued locally can settle an outstanding CDP
// request. Consume it before invoking a fixed operation so replay cannot settle
// twice, and wire data never selects an object method or supplies a callback.
export const settleResponse = (pending, message) => {
  if (!message || typeof message !== 'object' || Array.isArray(message)
    || !Number.isSafeInteger(message.id) || message.id <= 0) return false;
  const request = pending.get(message.id);
  if (!request) return false;
  pending.delete(message.id);
  request.settle(message);
  return true;
};
