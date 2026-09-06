// @ts-check
// Preview/dev Options entry. Store packaging replaces this whole entry with
// the committed build that cannot import the Contributor Metrics section.

import { ContributorMetricsSection } from '../sections/contributor-metrics.js';
import { makeOptionsApp } from './options-app-core.js';

export const OptionsApp = makeOptionsApp(ContributorMetricsSection);
