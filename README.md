# claude-code-mods

Claude Code mods by Petr Vanek.

| Mod | What it does |
|---|---|
| [`token-gauge`](mods/token-gauge) | Live gauges above the prompt: context window fill, prompt-cache state (warm countdown / cold), and the estimated cost of the next request. `/token-gauge` shows or hides them. |
| [`cache-keepalive`](mods/cache-keepalive) | Keeps the prompt cache warm with a cheap ping while the session is idle, within a break-even ping budget. Off by default; `/keepalive on \| off \| status`. |

## Install

```
/plugin install token-gauge --marketplace petrvnk/claude-code-mods
/plugin install cache-keepalive --marketplace petrvnk/claude-code-mods
```

## Develop

```
claude plugin validate mods/<mod>
claude plugin test mods/<mod>
```
