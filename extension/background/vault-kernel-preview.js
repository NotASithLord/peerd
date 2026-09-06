// @ts-check

import './kernel-preview-addon.js';
import { chromeKernelRuntimeModules } from './kernel-chrome-runtime-modules.js';
import { installVaultKernel } from './vault-kernel.js';

installVaultKernel(chromeKernelRuntimeModules);
