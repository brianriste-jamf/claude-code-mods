# Onboarding: cache-gauge and cache-keepalive

Every Claude Code message resends the whole conversation. While the prompt cache is warm that costs a cache read; once it is cold (5 minutes after the last request, by default) the next message pays a full cache write.

- **cache-gauge** shows how long the cache stays warm, what your next message costs warm and cold, and how full the context is.
- **cache-keepalive** (off by default) sends a cheap one-word ping while you are idle so the cache stays warm, and stops when a cold cache would have been cheaper.

Reference detail: [README.md](README.md), [mods/cache-gauge/README.md](mods/cache-gauge/README.md), [mods/cache-keepalive/README.md](mods/cache-keepalive/README.md).

## 1. Install

```bash
claude plugin marketplace add brianriste-jamf/claude-code-mods   # or a local clone: /path/to/claude-code-mods
claude plugin install cache-gauge@brian-mods --scope user
claude plugin install cache-keepalive@brian-mods --scope user
```

Then run `/reload-plugins` in a running session, or start a new one. `--scope user` loads the mods in every session. Confirm with `claude plugin list`.

After you pull changes, an installed mod keeps running its install-time copy until you update it:

```bash
claude plugin marketplace update brian-mods
claude plugin update cache-gauge@brian-mods
claude plugin update cache-keepalive@brian-mods
```

Then `/reload-plugins`. `update` re-records the version from `plugin.json`.

## 2. First five minutes

Send any message and wait for the reply. By default (`position: hint`) the gauge sits at the end of the hint line under the prompt:

```
● warm 4:40 · ctx 250k/367k 68%
```

- `● warm 4:40`: the cache goes cold in 4:40. Green, yellow in the last 20% of the lifetime (the last minute on a 5m cache). Reply before it reaches zero and your next message stays cheap.
- `○ cold`: the cache expired. Your next message pays the full write.
- `ctx 250k/367k 68%`: context used against where auto-compaction runs. Green under 50%, yellow under 80%, red above.
- `next msg $…`: what re-sending the context costs. A `~` before a price means it is the list price: no reply has calibrated it yet.

In `hint` position the price shows only when the cache is cold. To see both prices while warm, switch to the full band. In a session:

```
/plugin configure cache-gauge@brian-mods      # set position to "above"
```

(From a shell, `claude plugin configure cache-gauge@brian-mods` only lists options; saving needs `--values-stdin`.) The band then reads:

```
● warm 4:40 · next msg $0.06 (cold $1.56) · ctx 250k/367k ██████▊░░░ 68%
```

Worked example: with 2:00 left the line says `$0.06 (cold $1.56)`. Replying now costs $0.06 of context. Walking away for ten minutes makes the same message cost $1.56.

`/cache-gauge` toggles the line; `/cache-gauge show` and `/cache-gauge hide` set it explicitly.

## 3. Keepalive: arm it or not

Arm it when you will be idle longer than the cache lifetime and expect to continue the same conversation: a meeting, a long read, a build.

```
/cache-keepalive on
/cache-keepalive status     # model, cache lifetime and its source, pings used / budget, spacing
/cache-keepalive off
```

While armed, a second line appears under the gauge:

```
↻ keepalive 3/24 · $0.18 spent · next ping 2:10 · keeps warm ~1h40m
```

- **Cost of a ping:** one cache read of the whole context plus a one-word reply, shown as a real turn in the transcript. The line shows what the period has cost so far.
- **When it stops:** the budget is the smallest of break-even, `maxPings` (40) and `maxHours` (4). Break-even is `(write - read) / read` pings. Opus 5.5 and Sonnet 5.5 cache reads are 0.05x input and a 5m write is 1.25x, so `(1.25 - 0.05) / 0.05 = 24` pings on a 5m cache, about 1h48m. Fable 5.1 reads at 0.025x and gets 49; most other models read at 0.1x and get 11.
- **Reset:** any message you send starts a new idle period with a fresh budget. When the budget runs out you get one notification and the cache lapses.
- **Skip it** for gaps under about 5 minutes (just reply) or when you will not come back: pinging past break-even costs more than one cold write.

To arm it in every session, set `autoStart` with `/plugin configure cache-keepalive@brian-mods`. The other options (`intervalPercent`, `budgetFactor`, `maxPings`, `maxHours`, `notifyEvery`) are in the mod README.

## 4. Cache lifetime

Both mods default to `auto`, which reads Claude Code's own controls in this order and re-reads after each reply:

1. `FORCE_PROMPT_CACHING_5M=1` gives 5m
2. `CLAUDE_CODE_PROMPT_CACHE_TTL` (`5m` or `1h`)
3. the `promptCacheTtl` setting
4. `ENABLE_PROMPT_CACHING_1H=1` gives 1h
5. otherwise 5m

Set the gauge's `cacheTtl` or the keepalive's `ttl` to `5m` or `1h` to override all of that, and keep the two in agreement.

## 5. Troubleshooting

- **A number looks wrong:** run `/cache-gauge debug` to print the raw context figures the line is drawn from.
- **Prices look wrong before the first reply:** the `~` prefix means list price; it calibrates after the first usable reply.
- **Cache shows `○ cold` after `/model` or a compaction:** the cache is per model and resets on compaction. Expected; the next reply rewarms it.
- **Edited or pulled a mod and nothing changed:** run `claude plugin update <name>@brian-mods`, then `/reload-plugins`. To try a working copy without installing, run `claude --plugin-dir mods/<mod>`.
- **No alarm notification:** `brew install terminal-notifier` and allow it in System Settings, Notifications. Without it the alarm is a plain `osascript` banner. Turn the alarm off with `alarm: off`.
- **Keepalive says "cache already cold":** nothing to keep warm; send a message to rewarm it.
