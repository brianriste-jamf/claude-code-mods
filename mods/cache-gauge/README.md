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
| `◌ compacting` | A compaction is running; the cache shows cold once it finishes | dim |
| `◌ agent working` | A subagent is working: the main cache is not counting down for you to act on | dim |
| `◌ waiting for a reply` | Right after a start or reload: the context is known, the cache's state is not until a reply finishes | dim |
| `next msg $0.06` | What the next message pays to re-send the context: a cache read while warm, a full cache write once cold. Your new text and the reply are not included | |
| `(cold $1.56)` | While warm: what that same message would pay if you let the cache lapse | |
| `ctx 250k/367k` | Context of the last reply against where auto-compaction runs (set with `/autocompact`); against the model's window when auto-compaction is off | bar green < 50%, yellow < 80%, red above |

A `~` before the price means it is still the list price: no reply has given a usable calibration sample yet.

The line refreshes after every model request, so a long turn of tool calls keeps the cache warm rather than draining it from the previous reply. The countdown runs from the start of the last request (as the API measures it), so a long final answer shortens it. While Claude is working it shows just `● warm`; the countdown starts once the turn ends and nothing is being sent. Price calibration still happens once per reply. With `cache-keepalive` armed, its line sits right under this one. The countdown ticks every second while the cache is warm and stops once it has drawn it cold, and it catches up correctly after the machine sleeps through the expiry.

## Commands

| Command | Does |
|---|---|
| `/cache-gauge` | Toggle the line |
| `/cache-gauge show` / `hide` | Show or hide it explicitly |
| `/cache-gauge debug` | Print the raw context figures the line is drawn from, for diagnosing a number that looks wrong |

## Options

| Option | Default | Meaning |
|---|---|---|
| `cacheTtl` | `auto` | How long the cache stays warm after a reply. `auto` follows Claude Code's own controls, in this order: `FORCE_PROMPT_CACHING_5M=1`, `CLAUDE_CODE_PROMPT_CACHE_TTL`, the `promptCacheTtl` setting, `ENABLE_PROMPT_CACHING_1H=1`, else `5m`; re-read after each reply. `5m` or `1h` overrides all of those |
| `position` | `hint` | `above`: the full gauge in a band above the prompt. `hint`: the compact form below, at the end of the hint line under the prompt. This fork defaults to `hint`; upstream defaults to `above` |
| `hintColor` | `off` | `on`: with `position` `hint`, the dot and countdown turn yellow in the last minute and red when cold. The mod then draws the whole hint line itself, so a later mod's hint handler is skipped and engine changes to that line are not picked up |
| `alarm` | `notify` | `notify`: a warning 1 min before an idle cache goes cold. `countdown`: the warning, then a tense 15 s clip for the last 15 s. `off`: neither |
| `alarmSound` | empty | Absolute path to your own mp3, wav, m4a or aiff (4 MiB at most) to play instead of the bundled clip. An unreadable path falls back to the bundled one |

## Alarm

Once idle, the gauge raises one macOS notification per warm period and updates it in place (the same `terminal-notifier` group):

| Time left | Notification | Sound |
|---|---|---|
| 1 min | `Cache ending in 1m. Reply to keep your next message at $0.06; cold it costs $1.56.` plus a toast | Sosumi |
| 15 s | `Cache ending in 15s. ...` (same text), replacing the first | none; with `alarm` set to `countdown`, `sounds/countdown.mp3` starts, a 15 s clip that ends as the cache does |
| 0 | `Cache is cold. Your next message costs $1.56 (warm: $0.06).`, replacing it | none |

A message of yours, or the next model request, stops the clip, removes the notification and starts a new period. Nothing fires mid-turn or after a compaction, and a machine that wakes past the expiry stays quiet. macOS shows each in-place update as a fresh alert; there is no quiet-update option.

With [`terminal-notifier`](https://github.com/julienXX/terminal-notifier) installed (`brew install terminal-notifier`, then allow it in System Settings → Notifications), clicking the notification brings Ghostty forward and, inside herdr, runs `herdr agent focus <pane>` to select the agent that needs attention. Without it each step is a plain `osascript` banner (shown as Script Editor, no click action, no in-place update). To keep the notification on screen until dismissed, set its app (terminal-notifier or Script Editor) to **Alerts** (labelled **Persistent** on newer macOS) in System Settings → Notifications.

The bundled clip is synthesized: a triangle-wave figure over a sine thump, speeding up from 110 to 170 bpm (`sounds/make_countdown.py` regenerates it). To use your own sound, set `alarmSound`. Audio plays through `afplay`, so macOS only.

### Switching position

Run `/plugin configure cache-gauge@brian-mods` in a session and set `position`. From a shell, `claude plugin configure cache-gauge@brian-mods` only lists the options; it saves them only with `--values-stdin`. Or set it in `settings.json`; the mod picks it up on the next plugin reload or session start:

```json
"pluginConfigs": {
  "cache-gauge@brian-mods": { "options": { "position": "above" } }
}
```

`"above"` draws the full band above the prompt; `"hint"` (the default) draws the compact form under it.

## Position `hint`

With `position` set to `hint`, the gauge is drawn at the end of the hint line under the prompt, with no bar:

```
● warm 4:40 · ctx 250k/367k 68%
```

- No colour unless `hintColor` is `on`; without it, the dot blinks in the last minute instead.
- Cut where the row ends on a narrow terminal.
- The `next msg` price shows only when the cache is cold.

## herdr

Inside a [herdr](https://herdr.dev) pane (`HERDR_PANE_ID` set), the gauge also reports two pane metadata tokens under the source `cache-gauge`, whatever `position` is and whether or not the line is hidden. Outside herdr it does nothing, and a missing or failing `herdr` never affects the gauge.

| Token | Values |
|---|---|
| `cache` | `warm 5m`, `warm 4.5m` … `warm 0.5m` while idle (minutes left, rounded up to the next 30 s), plain `warm` mid-turn, `cold`, `compacting` (while a compaction runs), `working` (while a subagent works), or `waiting` (no reply yet, as in `◌ waiting for a reply`) |
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
