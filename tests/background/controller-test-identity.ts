export const TEST_CONTROLLER_KERNEL_IDENTITY = Object.freeze({
  schema: 1 as const,
  buildId: 'test-controller-build',
  bootId: 'test-controller-boot',
  kernelEpoch: 'test-controller-kernel',
});

let leaseGeneration = 0;

export const testControllerLease = () => {
  leaseGeneration += 1;
  return Object.freeze({
    ...TEST_CONTROLLER_KERNEL_IDENTITY,
    scope: 'controller',
    leaseId: `test-controller-lease-${String(leaseGeneration).padStart(8, '0')}`,
    hostEpoch: 'test-controller-host',
    generation: leaseGeneration,
  });
};

export const withTestControllerLease = async <T>(
  operation: (lease?: unknown) => Promise<T>,
) => operation(testControllerLease());
