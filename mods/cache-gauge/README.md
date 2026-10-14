# cache-gauge

One line above the Claude Code prompt that answers the two questions worth acting on: *should I reply before the cache goes cold?* and *how close am I to compaction?*

```
● warm 4:40 · next msg $0.06 (cold $1.56) · ctx 250k/367k ██████▊░░░ 68%
○ cold · next msg $1.56 · ctx 250k/367k ██████▊░░░ 68%
```

| Part | Shows | Colour |
|---|---|---|
| `● warm 4:40` | Time until the prompt cache goes cold | green; yellow in the last 20% of the lifetime (the last minute on a 5m cache) |
| `○ cold` | The cache has expired | red |
| `◌ waiting for a reply` | Right after a start or reload: the context is known, the cache's state is not until a reply finishes | dim |
| `next msg $0.06` | What the next message pays to re-send the context: a cache read while warm, a full cache write once cold. Your new text and the reply are not included | |
| `(cold $1.56)` | While warm: what that same message would pay if you let the cache lapse | |
| `ctx 250k/367k` | Context of the last reply against where auto-compaction runs (set with `/autocompact`); against the model's window when auto-compaction is off | bar green < 50%, yellow < 80%, red above |

A `~` before the price means it is still the list price: no reply has given a usable calibration sample yet.

The line refreshes after every model request, so a long turn of tool calls keeps the cache warm rather than draining it from the previous reply. While Claude is working it shows just `● warm`; the countdown starts once the turn ends and nothing is being sent. Price calibration still happens once per reply. With `cache-keepalive` armed, its line sits right under this one. The countdown ticks every second while the cache is warm and stops once it has drawn it cold, and it catches up correctly after the machine sleeps through the expiry.

## Commands

| Command | Does |
|---|---|
| `/cache-gauge` | Toggle the line |
| `/cache-gauge show` / `hide` | Show or hide it explicitly |
| `/cache-gauge debug` | Print the raw context figures the line is drawn from, for diagnosing a number that looks wrong |

## Options

| Option | Default | Meaning |
|---|---|---|
| `cacheTtl` | `5m` | How long the cache stays warm after a reply: `5m` or `1h`. Match it to the TTL your Claude Code session actually requests |

## How the cost is estimated

The estimate starts from list prices per model family (Opus, Sonnet, Haiku, Fable), then calibrates against what the session really pays: after each reply it divides the session's cost increase by that reply's tokens, weighted by kind (cache read, cache write, uncached input, output), and keeps a moving average. Until the first usable sample the price carries a `~`. This makes the figure right on Bedrock or enterprise pricing, where list prices do not apply. Replies that ran a subagent are skipped as samples, since the subagent's cost lands in the session total but not in the reply's own tokens.

## Known limitations

- `ctx` counts the input side of the last reply; the reply's own output, which the next request also sends, is not included.
- The line refreshes after each request and after a compaction: `ctx` drops to the compacted size and the cache shows `○ cold`, since nothing of the new conversation is cached until the next reply writes it. Changing the threshold with `/autocompact` shows on the next reply.
- After `/model` (or `/fast`) switches to another model, the price is that model's (with `~` until one of its replies calibrates it) and the cache shows `○ cold`: the prompt cache is per model, so the context is written again on the first message. Switching back within the lifetime shows the original cache warm again.
