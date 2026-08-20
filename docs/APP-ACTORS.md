# App actors

Every browser App has a host-owned actor bound to one App instance and one root
chat. The actor edits the App's readable OPFS/Git working tree. An App may also
opt into a narrow live-state adapter so that the same actor can exercise the
running artifact, observe the result, edit its files, and repeat.

Every App tab has a host-owned actor drawer. Every message sent there goes
directly to that tab's bound App actor and continues the same durable actor
conversation; it does not proxy through the orchestrator. The side panel remains
the broader orchestrator workspace for cross-App or browser-wide work.

An App can make this feel native by putting an **Ask peerd** or **Work with
peerd** button in its own UI:

```js
askPeerdButton.addEventListener('click', () => window.peerd.agent.open());
```

`open()` works only during a real user activation and can only reveal the
trusted drawer. App code cannot provide or submit a prompt, read the transcript,
invoke the model, or receive provider credentials and actor tools. The drawer's
input, transcript, direct actor dispatch, and reply rendering all belong to the
extension-owned parent shell outside the App iframe.

## Context templates

Actor context has three intentionally small layers:

1. **Host kernel.** A common, Spartan protocol states the pinned scope, exact
   capability signature, and untrusted-data rule. Every input is simply the next
   message in the actor's continuing conversation; the template does not change
   personality based on whether another actor or host UI supplied it.
2. **Host profile.** A named, versioned template supplies kind-specific operating
   knowledge and tools. Apps currently use `profile: "developer"` as the name
   of the code-and-history capability profile, not as a developer-only persona.
   The same actor helps use, test, edit, and version its App. Packages select a
   host-supported profile; they do not redefine its authority.
3. **Manifest role.** `agent.name` and `agent.instructions` describe this actor's
   purpose in the App. The orchestrator should customize these when it delegates
   a new App build. This role is provenance-labelled package context subordinate
   to the host kernel and the current host-authorized message, not a publisher-controlled
   system prompt.

This keeps the template mechanism simple: add a reviewed host profile when a
genuinely different capability or operating pattern is needed; use the manifest
role for ordinary customization. A document editor, game, diagrammer, or tracker
can all use the same developer profile with different semantic adapters and role
instructions.

## Creation flow

When asked to build an App, the orchestrator creates a minimal App shell, opens
it in the background, and delegates the build goal to that App's actor. The
default `peerd.json` creates a code-surface developer actor but grants no live
runtime operations. This is enough for ordinary Apps whose actor only edits and
versions files.

If the App benefits from live collaboration, its actor adds a semantic adapter:

```json
{
  "schema": 1,
  "kind": "app",
  "entry": "index.html",
  "agent": {
    "kind": "bound-app",
    "profile": "developer",
    "surface": "code",
    "name": "Document editor",
    "instructions": "Help the user revise the open document. Observe before editing and verify the resulting version.",
    "runtime": ["observe", "act"]
  },
  "capabilities": []
}
```

Both runtime methods must be declared together. Their implementation lives in
the App, not in peerd:

```js
window.peerd?.agent?.expose({
  observe: () => ({
    kind: 'document',
    version: documentVersion,
    text: editor.value,
    selection: { start: editor.selectionStart, end: editor.selectionEnd },
    dirty: documentIsDirty,
  }),
  act: ({ action, params }) => {
    if (action === 'replace-selection') {
      if (typeof params?.text !== 'string' || params.text.length > 20_000) {
        throw new TypeError('replacement text is invalid');
      }
      replaceSelection(params.text);
    } else if (action === 'set-title') {
      if (typeof params?.title !== 'string' || params.title.length > 200) {
        throw new TypeError('title is invalid');
      }
      setDocumentTitle(params.title);
    } else {
      throw new TypeError(`unsupported action: ${String(action)}`);
    }
    documentVersion += 1;
    renderDocument();
    return { applied: true, version: documentVersion };
  },
});
```

Offline Apps can persist bounded JSON without receiving an OPFS handle:

```js
const documentState = await window.peerd.data.get('document') ?? { text: '' };
await window.peerd.data.set('document', { text: editor.value, version: 2 });
const savedKeys = await window.peerd.data.list();
await window.peerd.data.delete('old-draft');
```

Keys are short safe names and map only to `data/<key>.json` in this App's
working tree. Values are limited to 1 MB of JSON per write and the normal App
file-count and total-size ceilings still apply. Debounce editor writes rather
than saving every keystroke. Because these files are intentionally readable to
Git, a Git push or dweb share includes them; the host UI says so before either
operation. Do not put secrets there.

The semantic adapter lives with the App tab, outside the service worker's cold
import graph. Reads resolve against that tab's pinned OPFS root; writes reuse
the existing exact-tab, repository-coordinated editor verbs. This is the default
extension pattern: feature validation and workflow belong in the lazy document
that presents the feature, while the worker keeps only small reusable authority
verbs. New App APIs should compose those verbs, not add worker controllers. Git
import follows the same split: Library owns clone/open UX and the worker exposes
only the vault-gated repository bootstrap operation.

This document editor is an example, not a special App kind. A game can expose
lobby and movement actions; a diagrammer can expose nodes and layout commands;
a tracker can expose rows, filters, and mutations. The durable primitive is the
same: a bounded JSON observation and a small allowlisted semantic action
vocabulary owned by the App.

## Git and durable work

Every App has a browser-native isomorphic-git repository beside its readable
OPFS working tree. The actor can inspect status and history, create local
checkpoints and branches, restore recoverably, and use a vault-bound HTTPS
remote after host confirmation. A person can do the same from Library under
**History & Git**. Library also exposes **Import Git**; the orchestrator uses the
same primitive with `sandbox_create({ kind: "app", gitUrl, gitRef })`.

A conforming Git repository places `peerd.json` and its entry file at the root.
Cloning preserves its branch, commit graph, remote, text files, and binary bytes;
opening it attaches the same root-pinned bound actor described above. A dwapp
manifest retains its `dweb` capability when imported in a dweb-enabled build.

Git versions bytes in the working tree, not arbitrary in-memory UI state. Apps
can keep user documents or other durable content in the `peerd.data` files
above, separated from JavaScript and assets, and checkpoint it at a meaningful
user- or actor-requested boundary. Rendering or changing volatile state alone
is never described as a save. Fetch never merges into the active branch, push
never forces, and every remote operation remains host-confirmed.

## Agent feedback loop

When the manifest declares both methods, the actor receives one code-first
`app_code` surface with this exact client:

```js
const before = await app.observe();
await app.act('replace-selection', { text: revisedText });
const after = await app.observe();
return { beforeVersion: before.version, after };
```

`app_code` is vocabulary and composition, not additional authority. Every
inner call crosses the existing exact-instance runtime gate and audit path.
Timeout, Stop, transport loss, or a handler failure after dispatch is treated
as an unknown outcome; the actor must observe a fresh generation before acting
again. File reads, edits, Git history, and versioning remain separate App-actor
tools so live state cannot smuggle filesystem or browser authority into the
sandbox.

## Design boundaries

- Expose semantic state, not raw DOM, selectors, arbitrary evaluation, or an
  unrestricted command dispatcher.
- Validate action names and parameters inside the App.
- Return bounded JSON snapshots and mutation receipts or state versions.
- Use `peerd.agent.open()` only to reveal the host UI; never emulate a prompt
  transport or place a provider client in the App.
- Do not expose secrets, provider calls, network access, or actor tools.
- App publisher instructions are subordinate, provenance-labelled role context;
  they are not user-authored system instructions.
- Changing `peerd.json` retires the stale actor generation and attaches a new
  digest- and authority-exact actor before the App resumes.

For a distributed App, use `kind: "dwapp"`, include the `dweb` capability, and
keep the same actor contract. Bundle transport, binary assets, and decoded Git
working-tree behavior are documented in [DWAPP-BUNDLE.md](DWAPP-BUNDLE.md).

The `dweb` capability belongs to the App's narrow parent bridge; it does not
silently add raw mesh tools to the App actor. A game actor, for example, sees
and changes lobby state through its declared `observe`/`act` vocabulary while
the dwapp code implements the authenticated room protocol. Peerd's separate
`dweb` actor is the browser-wide mesh operator for discovery, install, share,
moderation, and peer conversations. It uses the same common actor kernel and
message contract with its own host-reviewed network profile. Authority never
flows from one of these actors to the other merely because both concern P2P.
