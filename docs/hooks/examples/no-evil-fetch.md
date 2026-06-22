---
id: no-evil-fetch
event: pre-tool-use
match: '*'
rule:
  matchArg: url
  pattern: evil\.com
  onMatch: block
---
A declarative (no-code) hook: block any tool call whose `url` argument
contains `evil.com`. Declarative hooks run safely under any CSP — no
function construction — and are the recommended shape for simple
match-and-deny rules.
