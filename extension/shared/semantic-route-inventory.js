// @ts-check
export const SEMANTIC_ROUTE_INVENTORY = Object.freeze([
  {
    "route": "a2a/call",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/vault-kernel.js"
  },
  {
    "route": "actor-isolation/retry",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/system.js"
  },
  {
    "route": "actor/spawn",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/sessions.js"
  },
  {
    "route": "actors/call",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/actors.js"
  },
  {
    "route": "actors/list",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/actors.js"
  },
  {
    "route": "actors/count",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/kernel-semantic-control.js"
  },
  {
    "route": "actors/overview",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/kernel-semantic-control.js"
  },
  {
    "route": "agent/send",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/sessions.js"
  },
  {
    "route": "agent/stop",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/sessions.js"
  },
  {
    "route": "app/actor-chat",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/vault-kernel.js"
  },
  {
    "route": "app-code/observe",
    "channels": [
      "store",
      "preview"
    ],
    "source": "appRuntimeRoutes"
  },
  {
    "route": "app-code/act",
    "channels": [
      "store",
      "preview"
    ],
    "source": "appRuntimeRoutes"
  },
  {
    "route": "app/editor-delete",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/engine.js"
  },
  {
    "route": "app/editor-write",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/engine.js"
  },
  {
    "route": "app/editor/delete",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/engine.js"
  },
  {
    "route": "app/editor/list",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/engine.js"
  },
  {
    "route": "app/editor/read",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/engine.js"
  },
  {
    "route": "app/editor/write",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/engine.js"
  },
  {
    "route": "app/get-meta",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/engine.js"
  },
  {
    "route": "apps/delete",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/engine.js"
  },
  {
    "route": "apps/favorite",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/engine.js"
  },
  {
    "route": "apps/import-git",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/engine.js"
  },
  {
    "route": "apps/list",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/engine.js"
  },
  {
    "route": "apps/open",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/engine.js"
  },
  {
    "route": "apps/rename",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/engine.js"
  },
  {
    "route": "apps/repository/branch",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/engine.js"
  },
  {
    "route": "apps/repository/checkout",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/engine.js"
  },
  {
    "route": "apps/repository/commit",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/engine.js"
  },
  {
    "route": "apps/repository/diff",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/engine.js"
  },
  {
    "route": "apps/repository/fetch",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/engine.js"
  },
  {
    "route": "apps/repository/history",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/engine.js"
  },
  {
    "route": "apps/repository/link",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/engine.js"
  },
  {
    "route": "apps/repository/push",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/engine.js"
  },
  {
    "route": "apps/repository/restore",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/engine.js"
  },
  {
    "route": "apps/repository/status",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/engine.js"
  },
  {
    "route": "audit/list",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/system-read.js"
  },
  {
    "route": "audit/voice-fetch",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/system.js"
  },
  {
    "route": "commands/list",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/sessions.js"
  },
  {
    "route": "composer/files",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/sessions.js"
  },
  {
    "route": "composer/tabs",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/sessions.js"
  },
  {
    "route": "confirm/answer",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/vault-kernel.js"
  },
  {
    "route": "contacts/forget",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/kernel-semantic-authority.js"
  },
  {
    "route": "contacts/list",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/kernel-semantic-control.js"
  },
  {
    "route": "contacts/set",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/kernel-semantic-authority.js"
  },
  {
    "route": "contributor/disable",
    "channels": [
      "preview"
    ],
    "source": "extension/background/kernel-preview-addon.js"
  },
  {
    "route": "contributor/enable",
    "channels": [
      "preview"
    ],
    "source": "extension/background/kernel-preview-addon.js"
  },
  {
    "route": "contributor/feedback",
    "channels": [
      "preview"
    ],
    "source": "extension/background/kernel-preview-addon.js"
  },
  {
    "route": "contributor/status",
    "channels": [
      "preview"
    ],
    "source": "extension/background/kernel-preview-addon.js"
  },
  {
    "route": "cost/total",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/system-read.js"
  },
  {
    "route": "debug/originLock",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/vault-kernel.js"
  },
  {
    "route": "denylist/add",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/denylist.js"
  },
  {
    "route": "denylist/list",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/denylist.js"
  },
  {
    "route": "denylist/remove",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/denylist.js"
  },
  {
    "route": "dweb/app-install",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/dweb.js"
  },
  {
    "route": "dweb/app-record-served",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/dweb.js"
  },
  {
    "route": "dweb/app-snapshot",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/dweb.js"
  },
  {
    "route": "dweb/app-update",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/dweb.js"
  },
  {
    "route": "dweb/audit",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/dweb.js"
  },
  {
    "route": "dweb/base/announce",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/dweb.js"
  },
  {
    "route": "dweb/base/find",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/dweb.js"
  },
  {
    "route": "dweb/base/heard",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/dweb.js"
  },
  {
    "route": "dweb/base/install",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/dweb.js"
  },
  {
    "route": "dweb/base/room",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/dweb.js"
  },
  {
    "route": "dweb/base/share-app",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/dweb.js"
  },
  {
    "route": "dweb/base/start",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/dweb.js"
  },
  {
    "route": "dweb/base/status",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/dweb.js"
  },
  {
    "route": "dweb/base/stop",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/dweb.js"
  },
  {
    "route": "dweb/base/update-app",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/dweb.js"
  },
  {
    "route": "dweb/base/updates",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/dweb.js"
  },
  {
    "route": "dweb/distributed/info",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/dweb.js"
  },
  {
    "route": "dweb/ensure-seed-app",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/dweb.js"
  },
  {
    "route": "dweb/meta-admit",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/dweb.js"
  },
  {
    "route": "dweb/open-commons",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/dweb.js"
  },
  {
    "route": "dweb/self-apply-surface",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/dweb-self.js"
  },
  {
    "route": "dweb/self-prepare-offer",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/dweb-self.js"
  },
  {
    "route": "dweb/self-read-surface",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/dweb-self.js"
  },
  {
    "route": "dweb/self-restore",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/dweb-self.js"
  },
  {
    "route": "dweb/self-status",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/dweb-self.js"
  },
  {
    "route": "export/artifact",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/engine.js"
  },
  {
    "route": "git-cred/delete",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/peerd-engine/vm-net/git-credential-routes.js"
  },
  {
    "route": "git-cred/list",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/peerd-engine/vm-net/git-credential-routes.js"
  },
  {
    "route": "git-cred/set",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/peerd-engine/vm-net/git-credential-routes.js"
  },
  {
    "route": "hooks/list",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/hooks.js"
  },
  {
    "route": "hooks/remove",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/hooks.js"
  },
  {
    "route": "hooks/save",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/hooks.js"
  },
  {
    "route": "hooks/toggle",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/hooks.js"
  },
  {
    "route": "import/apply",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/engine.js"
  },
  {
    "route": "import/inspect",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/engine.js"
  },
  {
    "route": "learned/clear",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/learned-origins.js"
  },
  {
    "route": "learned/forget",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/learned-origins.js"
  },
  {
    "route": "learned/list",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/learned-origins.js"
  },
  {
    "route": "lifecycle/assert-opfs-writable",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/engine.js"
  },
  {
    "route": "local-model/catalog",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/local-model.js"
  },
  {
    "route": "local-model/init",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/local-model.js"
  },
  {
    "route": "local-model/probe",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/local-model.js"
  },
  {
    "route": "local-model/status",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/local-model.js"
  },
  {
    "route": "memory/delete",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/memory.js"
  },
  {
    "route": "memory/deleteAll",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/memory.js"
  },
  {
    "route": "memory/export",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/memory.js"
  },
  {
    "route": "memory/init",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/memory.js"
  },
  {
    "route": "memory/suggestions",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/memory.js"
  },
  {
    "route": "memory/suggestions/approve",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/memory.js"
  },
  {
    "route": "memory/suggestions/dismiss",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/memory.js"
  },
  {
    "route": "memory/write",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/memory.js"
  },
  {
    "route": "models/options",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/providers.js"
  },
  {
    "route": "onboarding/complete",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/memory.js"
  },
  {
    "route": "openrouter/models",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/providers.js"
  },
  {
    "route": "origin-cred/delete",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/peerd-egress/fetch/origin-credential-routes.js"
  },
  {
    "route": "origin-cred/list",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/peerd-egress/fetch/origin-credential-routes.js"
  },
  {
    "route": "origin-cred/set",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/peerd-egress/fetch/origin-credential-routes.js"
  },
  {
    "route": "page-program/navigate",
    "channels": ["store", "preview"],
    "source": "extension/background/kernel-turn-authority-adapter.js"
  },
  {
    "route": "page-program/click",
    "channels": ["store", "preview"],
    "source": "extension/background/kernel-turn-authority-adapter.js"
  },
  {
    "route": "page-program/fill",
    "channels": ["store", "preview"],
    "source": "extension/background/kernel-turn-authority-adapter.js"
  },
  {
    "route": "page-program/snapshot",
    "channels": ["store", "preview"],
    "source": "extension/background/kernel-turn-authority-adapter.js"
  },
  {
    "route": "page-program/read",
    "channels": ["store", "preview"],
    "source": "extension/background/kernel-turn-authority-adapter.js"
  },
  {
    "route": "page-program/read-state",
    "channels": ["store", "preview"],
    "source": "extension/background/kernel-turn-authority-adapter.js"
  },
  {
    "route": "page-program/watch-changes",
    "channels": ["store", "preview"],
    "source": "extension/background/kernel-turn-authority-adapter.js"
  },
  {
    "route": "page-program/query-dom",
    "channels": ["store", "preview"],
    "source": "extension/background/kernel-turn-authority-adapter.js"
  },
  {
    "route": "page-program/view",
    "channels": ["store", "preview"],
    "source": "extension/background/kernel-turn-authority-adapter.js"
  },
  {
    "route": "page-program/login",
    "channels": ["store", "preview"],
    "source": "extension/background/kernel-turn-authority-adapter.js"
  },
  {
    "route": "permission/set",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/offscreen/kernel-support-host.js"
  },
  {
    "route": "pod/cancel-io",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/engine.js"
  },
  {
    "route": "pod/get-meta",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/engine.js"
  },
  {
    "route": "pod/git",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/engine.js"
  },
  {
    "route": "pod/web-fetch",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/engine.js"
  },
  {
    "route": "private-transfer/open",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/vault-kernel.js"
  },
  {
    "route": "provider/setKey",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/providers.js"
  },
  {
    "route": "provider/status",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/providers.js"
  },
  {
    "route": "provider/test",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/providers.js"
  },
  {
    "route": "repository/kernel-fetch",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/vault-kernel.js"
  },
  {
    "route": "script-run/abort",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/actors.js"
  },
  {
    "route": "script/model-call",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/vault-kernel.js"
  },
  {
    "route": "session/archive",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/session-mutations.js"
  },
  {
    "route": "session/contextSnapshots",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/offscreen/kernel-support-host.js"
  },
  {
    "route": "session/debugBundle",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/sessions.js"
  },
  {
    "route": "session/get",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/offscreen/kernel-support-host.js"
  },
  {
    "route": "session/list",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/offscreen/kernel-support-host.js"
  },
  {
    "route": "session/reset",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/session-mutations.js"
  },
  {
    "route": "session/setModel",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/offscreen/kernel-support-host.js"
  },
  {
    "route": "session/switch",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/session-mutations.js"
  },
  {
    "route": "settings/reset",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/settings.js"
  },
  {
    "route": "settings/update",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/settings.js"
  },
  {
    "route": "sidepanel/close",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/system.js"
  },
  {
    "route": "site-client/delete",
    "channels": [
      "store",
      "preview"
    ],
    "source": "siteClientRoutes"
  },
  {
    "route": "site-client/list",
    "channels": [
      "store",
      "preview"
    ],
    "source": "siteClientRoutes"
  },
  {
    "route": "site-fetch/call",
    "channels": [
      "store",
      "preview"
    ],
    "source": "siteFetchCallRoute"
  },
  {
    "route": "skills/installGit",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/skills.js"
  },
  {
    "route": "skills/installLocal",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/skills.js"
  },
  {
    "route": "skills/installManifest",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/skills.js"
  },
  {
    "route": "skills/list",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/skills.js"
  },
  {
    "route": "skills/remove",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/skills.js"
  },
  {
    "route": "skills/setEnabled",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/skills.js"
  },
  {
    "route": "state/get",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/system-read.js"
  },
  {
    "route": "surfaces/get",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/system-read.js"
  },
  {
    "route": "sw/web-fetch",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/engine.js"
  },
  {
    "route": "sw/web-fetch-abort",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/engine.js"
  },
  {
    "route": "transfer/export",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/settings.js"
  },
  {
    "route": "transfer/import",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/system.js"
  },
  {
    "route": "transfer/inspectImport",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/system.js"
  },
  {
    "route": "vault/disablePrf",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/vault.js"
  },
  {
    "route": "vault/enrollPrf",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/vault.js"
  },
  {
    "route": "vault/initialize",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/vault.js"
  },
  {
    "route": "vault/initializeWithPasskey",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/vault.js"
  },
  {
    "route": "vault/lock",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/vault.js"
  },
  {
    "route": "vault/prfStatus",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/vault.js"
  },
  {
    "route": "vault/setRecoveryPassphrase",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/vault.js"
  },
  {
    "route": "vault/unlock",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/vault.js"
  },
  {
    "route": "vault/unlockPrf",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/vault.js"
  },
  {
    "route": "vm/get-meta",
    "channels": [
      "store",
      "preview"
    ],
    "source": "extension/background/routes/engine.js"
  }
]);
