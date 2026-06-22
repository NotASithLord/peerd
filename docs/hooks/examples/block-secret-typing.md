---
id: block-secret-typing
event: pre-tool-use
match: type
order: 50
trusted: true
---
Block the `type` tool from entering anything that looks like a provider
API key into a page. A model steered by a hostile page might try to
paste a stored credential into an attacker-controlled form; this is a
hard stop that doesn't depend on the user noticing.

```js
// inv = { event, toolName, args, ctx }
if (/sk-[A-Za-z0-9]{20,}/.test(inv.args.text ?? "")) {
  return { action: "block", reason: "refusing to type something that looks like a secret key" };
}
return { action: "allow" };
```
