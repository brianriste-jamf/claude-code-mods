# cache-gauge

Three live gauges above the Claude Code prompt, refreshed after every reply.

```
ctx   ████░░░░░░░░░░░░░░░░  187k/1.0M  19% · compact at 830k
cache ███████████████████░  97% hit · warm 3:42
next  █░░░░░░░░░░░░░░░░░░░  ~$0.04 (cold ~$0.94) · session $3.12   [Hide]
```

| Row | Shows | Colour |
|---|---|---|
| `ctx` | Input tokens of the last reply against the window auto-compaction measures against, and the compaction threshold when auto-compaction is on. When `/autocompact` set that window below the model's, the model's window follows as `model 1.0M` | green < 50%, yellow < 80%, red above |
| `cache` | Share of the last reply's input served from cache, and a countdown until the cache goes cold | by hit ratio while warm; red once cold |
| `next` | Estimated cost of re-sending the current context on the next message: as a cache read while warm, as a cache write once cold. Then the session total | against `maxRequestUsd` |

The countdown ticks every second while the cache is warm and stops once it has drawn it cold, so an idle session costs nothing. It also catches up correctly after the machine sleeps through the expiry.

## Commands

| Command | Does |
|---|---|
| `/cache-gauge` | Show or hide the gauges (the **Hide** button does the same) |
| `/cache-gauge debug` | Print the raw context figures the gauges are drawn from, for diagnosing a number that looks wrong |

## Options

| Option | Default | Meaning |
|---|---|---|
| `cacheTtl` | `5m` | How long the cache stays warm after a reply: `5m` or `1h`. Match it to the TTL your Claude Code session actually requests |
| `maxRequestUsd` | `0.5` | The next-request cost the `next` bar treats as full |

## How the cost is estimated

The estimate starts from list prices per model family (Opus, Sonnet, Haiku, Fable), then calibrates against what the session really pays: after each reply it divides the session's cost increase by that reply's tokens, weighted by kind (cache read, cache write, uncached input, output), and keeps a moving average. Until the first usable sample the row says `list price`. This makes the figure right on Bedrock or enterprise pricing, where list prices do not apply. Replies that ran a subagent are skipped as samples, since the subagent's cost lands in the session total but not in the reply's own tokens.

## Known limitations

- `ctx` counts the input side of the last reply; the reply's own output, which the next request also sends, is not included.
- The gauges refresh when a reply finishes. After `/compact` or `/autocompact` they show the old figures until the next reply.
