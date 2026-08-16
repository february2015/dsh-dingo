# dsh-dingo 2.0

**English** | [中文](README.zh.md)

**Ding + Go** — a DSH plugin for session cards, auto-naming, sounds, and deep links.

## Features

- 1:1 persistent session cards
- Multiple statuses with colors and priority ordering
- Compact summary pill + hover detail panel
- Cross-session draft detection
- Background job / subagent / swarm waiting state
- Current workspace label
- Background task count display
- Auto-naming (button / natural language / command)
- Sounds + system notifications + deep-link (kept from 1.x)

## Status Priority

![Status Priority](docs/assets/priority-en.svg)

| Priority | Status | Meaning | Color |
|---|---|---|---|
| 1 | Error | task failed / abnormal end | red |
| 2 | Question | needs your answer | orange |
| 3 | Draft | another session has unsent input | purple |
| 4 | To Read | completed and needs reading | green |
| 5 | Waiting | main done, background/subtasks/swarm still running | teal |
| 6 | Intermediate | running with partial output | cyan |
| 7 | Running | running | blue spinner |
| 8 | Normal | completed and seen | grey |

> Typing in the current session is a normal state and does not trigger the draft reminder; after switching away, the previous session's draft becomes a purple reminder again.

## Usage

- The session header shows:
  - Workspace label: the current session's workspace.
  - `Rename` button: auto-name the current session.
  - Summary pill: status counts for all active sessions.
- Hover or click the summary pill to open the detailed panel:
  - First line: workspace name (with a small spinner + unfinished background task count if any).
  - Second line: session name.
  - Different colors per status.
  - Click a card to open that session.
  - `×` removes the card for this round.
- The panel auto-closes after 5 seconds, or you can click the pill to toggle it.
- Subagent / Worker sessions do not appear in the card list.

![Stats Pill](docs/assets/stats-pill.svg)

![Card Panel](docs/assets/card-panel-en.svg)

## Auto Naming

| Entry | Method |
|---|---|
| `Rename` button | independent DeepSeek V4 Flash call |
| Natural language in chat | main LLM generates title, then calls `rename_current_session` tool |
| `/dingo rename` | fallback command using the independent Flash path |

## TaskSwarm Integration

dsh-dingo can work with [dsh-taskswarm](https://github.com/february2015/dsh-taskswarm):

- TaskSwarm exposes a standard Cordis service via `ctx.get('taskswarm')`.
- dsh-dingo reads active batches from it.
- If a session started a swarm batch that is still running, its card shows the **waiting / swarm** state even after the main conversation has finished.

Both plugins can be used independently or together.

## Commands

```
/dingo on|off
/dingo status
/dingo dnd [on|off]
/dingo rename
```

## Install

```bash
dsh plugin --profile web add /path/to/dsh-dingo
# or
dsh plugin --profile web add dsh-dingo
```

Restart DSH after building/updating.

## Development

```bash
npm install
npm run typecheck
npm test
npm run verify
```

See [docs/v2-features.md](docs/v2-features.md) and [docs/dsh-plugin-dev-tips.md](docs/dsh-plugin-dev-tips.md).

## License

MIT
