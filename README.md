# dsh-dingo

**English** | [中文](README.zh.md)

**Ding + Go** — sound reminders + **one-click jump** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).

Hear it, reach it: when another conversation replies, a tone alerts you and a small card appears — **one click takes you straight to that conversation**; and when you've switched to another app, a **system notification** (macOS Notification Center / Windows toast) still gets through — click it to jump right in. It doesn't just tell you "something happened"; it puts you in front of the conversation (the core capability that sets it apart from plain notifiers).

**Great when you run many conversations in parallel**: open several chats (including subagents) side by side and stop watching them one by one — when any of them replies, you hear a distinct tone and the card shows the workspace/conversation name; click it and you're there. Never miss a reply while you work on something else, and switch between tasks with ease.

Current conversation replies → **dang / dang-dang** (crisp tone set); other conversations → **another sound (ding, soft tone set)** + a top-right **card**; click the card to **jump straight to** that conversation. Pure event-driven and lightweight.

---

## What it does

| Scenario | Sound | Card |
|---|---|---|
| **Current conversation** has a reply (plain statement) | dang (1 beep, crisp) | none (you're already looking at it) |
| **Current conversation** needs your answer (question/confirmation) | dang-dang (2 beeps, crisp) | none |
| **Another conversation** has a reply | ding (soft) 1 beep | ✅ top-right card |
| **Another conversation** needs your answer | ding-ding (soft) 2 beeps | ✅ top-right card |
| Task failed | dong (low tone) | ✅ card |

**When does a reply "need your answer"?** Works for both **English and Chinese**. Structured signals first — `ask_user` tool calls, approval requests (`approval/asked`), and questions-domain prompts always count as "needs answer". For plain text, the heuristic is deliberately strict to avoid mistaking the model's self-talk for a question to you:
- Explicit request for action / decision / confirmation ("please confirm", "please choose", "your call", "what do you think"… / 请确认、需要你拍板、你怎么看…) → needs answer;
- Question mark + question tone (wh-words, auxiliary-verb questions… / 吗/呢/怎么/是否…) → needs answer, but **excludes** rhetorical questions ("Isn't this obvious?" / 难道…吗？), self-answered Q&A ("Should we roll back? No, because…" / …吗？因为/其实…), and question-list enumerations (…? Next… / …？其次…);
- Question words in a plain statement without a question mark → just a reply.

**The card** (other conversations only):
- Fixed 200×56, semi-transparent floating;
- Shows: status icon + workspace name (≤12 chars) + conversation title (≤10 chars);
  - 🟩 green square = reply, 🟠 question mark = needs answer, 🔴 exclamation = failed;
- **Click the card → jump to that conversation**; **×** in the corner closes it;
- Cards stack from the top right (below the Session log button), 8px apart; after a jump, the remaining cards reflow up;
- Cards stay for 30s after the alert so you can click/close them, then auto-dismiss.

**Reminder discipline**:
- The **same reminder** in the same conversation won't repeat within 10s (content-based dedup: different reminders still ring; each conversation tracks its own window);
- `/dingo dnd on` do-not-disturb: task-completion reminders go silent, "needs answer" still alerts;
- Configurable quiet hours (`quietHours` "HH:mm", overnight supported) — task-class reminders queue silently and play after the window ends;
- `/dingo off` disables all reminders.

**System notifications** (macOS Notification Center / Windows toast, optional):
- When another conversation needs your answer / replies / fails, a **system-level notification** is sent in addition to the in-browser card — so you notice even while working in another app;
- **Click the notification → jumps straight to that conversation** (deep link `?dingOpen=`);
- Suppressed while the DSH Web UI is visible in the foreground (the in-browser tones/cards are enough); sent when the page is in the background or not open;
- macOS requires `brew install terminal-notifier` once; Windows uses built-in PowerShell (scripts under `scripts/`).

---

## Install

```bash
# From local source (development)
dsh plugin --profile web add /path/to/dsh-dingo

# Or from npm (released)
dsh plugin --profile web add dsh-dingo

# Replace "web" with your target profile name if different
```

### System-notification prerequisites (optional feature)

The optional system notifications (macOS Notification Center / Windows toast) need:

- **macOS**: install once — `brew install terminal-notifier`. Without it, system notifications are skipped silently and only the in-browser cards/tone work.
- **Windows**: nothing to install — uses built-in PowerShell (`scripts/notify.ps1` + `scripts/toast-activate.ps1`).

Disable anytime with `systemNotify: false` (see config below).

Overridable in the profile's `cordis.patch.yml` or plugin config:

```yaml
- id: dsh-dingo
  config:
    enabled: true
    feedback:
      toneStyle: soft        # tone set: soft (other conversations "ding") / crisp (current conversation "dang")
      dnd: false
      dedupeWindowMs: 10000  # same-conversation same-content dedup window (same reminder won't repeat, different ones ring)
      quietHours: { start: '', end: '' }
    # systemNotify: true       # system notifications for other conversations (default on)
    # systemNotifyBaseUrl: ''  # deep-link base URL (default http://127.0.0.1:3080)
```

## Commands

```
/dingo on|off        # enable/disable reminders
/dingo status        # enabled/DND/queue status
/dingo dnd [on|off]  # do-not-disturb (task-completion silent, needs-answer still alerts)
```

## Architecture

- **host half** (`src/index.ts` + `src/feedback.ts`):
  - Subscribes to `session/event`: `turn/end(completed)` / `approval/asked` / `tool/call(ask_user)` / `assistant/message` → classifies → enqueues (priority: needs-answer > reply > failure);
  - Current-conversation replies (from the client's reported active session) → own reminder (tone only, no card);
  - Queue plays serially by priority; the client reports `spoken` before the next item plays;
- **client half** (`src/client/FeedbackCard.tsx` + `tones.ts`):
  - Polls the `/dingo.feedback` snapshot → current-conversation items play crisp (dang/dang-dang), other-conversation items play soft (ding) + render cards;
  - Two built-in tone sets (soft/crisp, data-URL WAV), no external audio files;
  - Clicking a card calls client-side `sessions.open` to jump to the conversation (same entry point as the sidebar).
- **RPC** (`/dingo` channel): `feedback` / `set-current-session`.

## Development

```bash
npm install
npm run typecheck   # type checking
npm test            # vitest
npm run verify      # typecheck + test + build
```

## License

MIT

Windows system-notification scripts adapted from [CAOGGL/dsh-ding](https://github.com/CAOGGL/dsh-ding) (MIT) — see [LICENSE](LICENSE) third-party notices.
