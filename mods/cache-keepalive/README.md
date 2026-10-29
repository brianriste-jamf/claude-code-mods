# cache-keepalive

Keeps the Claude Code prompt cache warm while the session sits idle, so the next message reads the conversation from cache instead of paying to write it again.

While armed, it watches how long the session has been idle. Shortly before the cache would expire it sends a one-line ping:

```
Cache keep-alive ping. Reply with the single word "ok" and use no tools.
```

That ping is a real turn in the transcript. It costs a cache read of the context plus a one-word reply, and it restarts the cache's lifetime. Off by default.

## Commands

| Command | Does |
|---|---|
| `/cache-keepalive on` | Arm it for this session |
| `/cache-keepalive off` | Disarm it |
| `/cache-keepalive status` | Model, cache lifetime and where it was read from, pings used / budget, spacing |

While armed, it draws a line above the prompt, under `cache-gauge`'s when that mod is installed:

```
↻ keepalive 3/24 · $0.09 spent · next ping 2:10 · keeps warm ~1h34m
↻ keepalive 24/24 · $0.72 spent · budget used, cache lapses in 4:12
↻ keepalive 3/24 · waits for the turn to end
↻ keepalive 0/24 · cache already cold, nothing to keep warm
```

*spent* is what this idle period's pings have cost, measured from the session's total. *keeps warm* is how long the cache will stay warm if you stay away: the remaining pings plus one cache lifetime after the last. Off, it draws nothing.

## Notifications

Each ping raises a native notification through your terminal's notification channel (the `preferredNotifChannel` setting), so you see what idling costs even when you're away from the terminal:

```
Cache keep-alive
Idle: ping 3/24, $0.09 spent with nobody working; keeps the cache warm ~1h34m more. Reply, or /cache-keepalive off.
```

When the budget runs out, a last notification says so. Set `notifyEvery` to `3` to hear only every third ping, or to `0` to turn notifications off. The band line still shows the cost either way.

## When it stops pinging

Pinging forever would cost more than letting the cache go cold once. So each idle period has a budget, the smallest of:

1. **Break-even.** A cold cache costs one cache write of the context; each ping costs one cache read. Pinging pays off only up to `(write − read) / read` pings, scaled by `budgetFactor`. On Claude Opus 5.5 with a 5-minute cache that is `(1.25 − 0.05) / 0.05 = 24` pings, about 1h48m of idle time at the default spacing.
2. **`maxPings`**, a hard cap.
3. **`maxHours`**, the longest an idle period is kept warm. This matters for a 1-hour cache, where break-even alone would allow almost a day.

When the budget runs out it notifies you once and lets the cache lapse. Any message of your own starts a new idle period with a fresh budget. Its own pings do not. Subagent turns are ignored, since they say nothing about the main conversation's cache. After the machine sleeps past the expiry it sees the cache is already cold and sends nothing.

## Cache lifetime

With `ttl: auto` it reads the lifetime from Claude Code's own controls, in Claude Code's precedence:

1. `FORCE_PROMPT_CACHING_5M=1` → 5m
2. `CLAUDE_CODE_PROMPT_CACHE_TTL` (`5m` / `1h`)
3. the `promptCacheTtl` setting
4. `ENABLE_PROMPT_CACHING_1H=1` → 1h
5. otherwise **5m**, assumed. A 1-hour cache then gets pinged more often than it needs, which is the safe direction.

## Options

| Option | Default | Meaning |
|---|---|---|
| `autoStart` | `false` | Arm it when a session starts |
| `ttl` | `auto` | `auto`, `5m` or `1h` (see above) |
| `intervalPercent` | `90` | Idle share of the lifetime before a ping, clamped to 50–95. 90 is 4:30 on a 5m cache |
| `budgetFactor` | `1` | Scales the break-even budget: `0.5` stops at half of it |
| `maxPings` | `40` | Hard cap on pings per idle period |
| `maxHours` | `4` | Hard cap on how long one idle period is kept warm |
| `notifyEvery` | `1` | Raise a notification after every Nth ping; `0` turns them off |

Read prices come from the model id: 0.025× input for Fable and Mythos, 0.05× for Opus 5.5 and Sonnet 5.5, 0.1× for everything else.
