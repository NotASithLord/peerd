// gtm/seeds.ts - WHERE we start crawling. This file is meant to be edited.
//
// Seed choice IS the strategy: the crawl maps the neighborhoods around
// these seeds, so pick seeds whose communities overlap peerd's actual
// wedge - people who would want a browser-native, BYOK, no-backend agent
// that can also run code locally and speak p2p. The defaults below cover
// peerd's four adjacent communities; prune or extend before a real run.

export interface Seeds {
  /** owner/name - contributors + their in-community follow graph */
  githubRepos: string[];
  /** Bluesky handles - followers/follows neighborhoods via the public AppView */
  blueskyActors: string[];
  /** HN Algolia queries - story authors + commenters as engagement edges */
  hnQueries: string[];
}

export const DEFAULT_SEEDS: Seeds = {
  githubRepos: [
    // browser agents - peerd's most direct community
    'browser-use/browser-use',
    'nanobrowser/nanobrowser',
    // the substrate peerd runs code on (its users grok "Linux in a tab")
    'leaningtech/webvm',
    // local / in-browser inference - the BYOK + privacy crowd
    'ollama/ollama',
    'huggingface/transformers.js',
    'mlc-ai/web-llm',
    // local-first - the "no backend, your data" crowd
    'automerge/automerge',
    'yjs/yjs',
    // dweb / p2p - the peerd-distributed audience
    'libp2p/js-libp2p',
    'ipfs/helia',
    'bluesky-social/atproto',
  ],
  blueskyActors: [
    // dweb / local-first gravity wells; their follower neighborhoods are
    // dense with exactly the people who evangelize tools like peerd.
    'pfrazee.com',
    'martin.kleppmann.com',
    'inkandswitch.com',
    'bnewbold.net',
    'why.bsky.team',
  ],
  hnQueries: [
    'browser agent',
    'local-first',
    'bring your own key',
    'WebVM',
    'browser extension AI',
  ],
};
