// @ts-check

import { chromeKernelRuntimeModules } from './kernel-chrome-runtime-modules.js';
import { installVaultKernel } from './vault-kernel.js';

installVaultKernel(chromeKernelRuntimeModules);
