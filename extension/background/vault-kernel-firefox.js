// @ts-check

import './kernel-firefox-addon.js';
import { firefoxKernelRuntimeModules } from './kernel-firefox-runtime-modules.js';
import { installVaultKernel } from './vault-kernel.js';

installVaultKernel(firefoxKernelRuntimeModules);
