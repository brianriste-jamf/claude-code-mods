# claude-code-mods

Claude Code mods for keeping an eye on the **prompt cache**: what it holds, how long it stays warm, and what the next request will cost.

Every message resends the whole conversation. While the prompt cache is warm, the part already sent is read from cache at a fraction of the input price; once it goes cold (5 minutes by default), the next message pays to write all of it again. These two mods make that visible and, optionally, keep it from happening while you step away.

| Mod | What it does | Command |
|---|---|---|
| [**cache-gauge**](mods/cache-gauge) | One line above the prompt: how long the cache stays warm, what the next message costs warm and cold, and how close the context is to compaction | `/cache-gauge` |
| [**cache-keepalive**](mods/cache-keepalive) | Keeps the cache warm with a cheap ping while the session is idle, and stops once a cold cache would have been cheaper | `/cache-keepalive on \| off \| status` |

```
● warm 4:40 · next msg $0.06 (cold $1.56) · ctx 250k/367k ██████▊░░░ 68%
↻ keepalive 3/24 · next ping 2:10 · keeps warm ~1h34m
```

The first line is `cache-gauge`, the second `cache-keepalive` while it is armed. Each mod draws its own line and keeps the other's, so either works alone. Set `cache-gauge`'s `position` option to `hint` to move it to the hint line under the prompt.

## Install

In a Claude Code session:

```
/plugin install cache-gauge --marketplace petrvnk/claude-code-mods
/plugin install cache-keepalive --marketplace petrvnk/claude-code-mods
```

Answer `y` to add the marketplace, then pick the **user** scope so the mods load in every session. The repository is private: the machine needs git access to it under an account that can read it.

From a shell, the same thing:

```bash
claude plugin marketplace add petrvnk/claude-code-mods
claude plugin install cache-gauge@petrvnk-mods --scope user
claude plugin install cache-keepalive@petrvnk-mods --scope user
```

### Update

```bash
claude plugin marketplace update petrvnk-mods
claude plugin update cache-gauge@petrvnk-mods
claude plugin update cache-keepalive@petrvnk-mods
```

Then `/reload-plugins` in a running session, or start a new one.

### Configure

Both mods have options (see each mod's README). Set them with `/plugin configure <mod>@petrvnk-mods`, or at install time with `--config KEY=VALUE`.

## Using them together

`cache-gauge` shows the countdown; `cache-keepalive` acts on it. A typical setup:

1. Leave `cache-gauge` on all the time.
2. Before a meeting or a long read, run `/cache-keepalive on`. Its line appears under the gauge with the next ping and how long the cache will stay warm; the gauge stays `warm` while you are away, and each ping shows up in the transcript as a one-word turn.
3. Back at the keyboard, just type: your own message resets the ping budget.

## Develop

Each mod is a folder under `mods/` with `.claude-plugin/plugin.json` and a hooks module in `hooks/`.

```bash
claude plugin validate .                  # marketplace + every mod
claude plugin validate mods/<mod>
claude plugin test mods/<mod>             # runs hooks/*.test.ts
claude --plugin-dir mods/<mod>            # try a working copy without installing it
```

An installed mod runs the copy made at install time, so a change reaches your sessions only after it is pushed and updated (above). Bump `version` in the mod's `plugin.json` with each change you ship.

## Repository layout

```
.claude-plugin/marketplace.json   marketplace "petrvnk-mods"
mods/
  cache-gauge/                    gauges above the prompt
  cache-keepalive/                idle keep-alive pings
```
