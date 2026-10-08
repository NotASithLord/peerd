// why: a shared ControlMaster cannot prove ownership of an existing forward.
// A dedicated connection owns its forward for exactly its process lifetime.
export const sshArguments = (options = []) => {
  if (!Array.isArray(options) || options.some(value => typeof value !== 'string')) throw new Error('sshOptions must be an argument array');
  if (options.some(value => /^-(?:S|O|M|N|f)/.test(value) || /^(?:-o)?Control(?:Path|Master|Persist)(?:=|\s|$)/i.test(value))) {
    throw new Error('Cluster SSH requires a dedicated connection; shared control options are not supported');
  }
  return ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2',
    '-o', 'ControlMaster=no', '-o', 'ControlPersist=no', ...options, '-S', 'none'];
};
