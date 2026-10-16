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
| `position` | `hint` | `above`: the full gauge in a band above the prompt. `hint`: the compact form below, at the end of the hint line under the prompt. This fork defaults to `hint`; upstream defaults to `above` |

### Switching position

Run `/plugin configure cache-gauge@brian-mods` in a session, or `claude plugin configure cache-gauge@brian-mods` from a shell, and set `position`. Or set it in `settings.json`; the mod picks it up on the next plugin reload or session start:

```json
"pluginConfigs": {
  "cache-gauge@brian-mods": { "options": { "position": "above" } }
}
```

`"above"` draws the full band above the prompt; `"hint"` (the default) draws the compact form under it.

## Position `hint`

With `position` set to `hint`, the gauge is drawn at the end of the hint line under the prompt, with no price and no bar:

```
● warm 4:40 · ctx 250k/367k 68%
```

- No colour: the hint line is one string.
- Cut where the row ends on a narrow terminal.
- `ctx` and the cache state only; the `next msg` price is shown in `above` mode.

## herdr

Inside a [herdr](https://herdr.dev) pane (`HERDR_PANE_ID` set), the gauge also reports two pane metadata tokens under the source `cache-gauge`, whatever `position` is and whether or not the line is hidden. Outside herdr it does nothing, and a missing or failing `herdr` never affects the gauge.

| Token | Values |
|---|---|
| `cache` | `warm 5m`, `warm 4.5m` … `warm 0.5m` while idle (minutes left, rounded up to the next 30 s), plain `warm` mid-turn, `cold`, or `waiting` (no reply yet, as in `◌ waiting for a reply`) |
| `ctx` | The context fill as a whole percent, a bare number such as `68`, so numeric rules (`gt`) apply |

A `warm` value carries `--ttl-ms` set to the lifetime left, as a backstop: herdr deletes an expired token, and the gauge sends `cache=cold` itself when the lifetime runs out. `ctx` is sent separately, with a 24 h backstop so a crashed session's value goes eventually. Tokens go out at start, when the countdown text changes (every 30 s), after each reply, a compaction or a `/model` switch, and when the cache goes cold; an unchanged value is not sent again. Both tokens are cleared when the session ends.

The gauge also sets the pane's display agent to the current model (`opus 5.5`, `sonnet 4.6`) while `claude` is the pane's agent, so the sidebar's `agent` slot names the model; it is cleared with the tokens.

Show them in herdr's Agent sidebar (the first matching rule wins, so the last-minute rules precede the `warm` prefix):

```toml
[ui.sidebar.agents]
rows = [
  ["state_icon", "machine", "workspace", "tab"],
  ["agent", { token = "$cache", rules = [{ starts_with = "cold", fg = "#f55" }, { equals = "warm 1m", fg = "#fc0" }, { starts_with = "warm 0.", fg = "#fc0" }, { starts_with = "warm", fg = "#5c5" }] },
            { token = "$ctx", rules = [{ gt = 80, fg = "#f55" }, { gt = 50, fg = "#fc0" }] }],
]
```

## How the cost is estimated

The estimate starts from list prices per model family (Opus, Sonnet, Haiku, Fable), then calibrates against what the session really pays: after each reply it divides the session's cost increase by that reply's tokens, weighted by kind (cache read, cache write, uncached input, output), and keeps a moving average. Until the first usable sample the price carries a `~`. This makes the figure right on Bedrock or enterprise pricing, where list prices do not apply. Replies that ran a subagent are skipped as samples, since the subagent's cost lands in the session total but not in the reply's own tokens.

## Known limitations

- `ctx` counts the input side of the last reply; the reply's own output, which the next request also sends, is not included.
- The line refreshes after each request and after a compaction: `ctx` drops to the compacted size and the cache shows `○ cold`, since nothing of the new conversation is cached until the next reply writes it. Changing the threshold with `/autocompact` shows on the next reply.
- After `/model` (or `/fast`) switches to another model, the price is that model's (with `~` until one of its replies calibrates it) and the cache shows `○ cold`: the prompt cache is per model, so the context is written again on the first message. Switching back within the lifetime shows the original cache warm again.
