# OpenClaw Dispatch 範例

OpenClaw 使用 agentic-coding-orchestrator (ACO) 驅動 Claude Code (CC)
完成 ACF 專案的完整流程。

## 核心原則

1. **OpenClaw 不直接操作 CC** — 透過 `dispatch-claude-code.sh` 或 `orchestrator auto`
2. **OpenClaw 不自己讀 HANDOFF.md** — 等 hook 通知，避免 race condition
3. **OpenClaw 只發一句 dispatch 確認** — 完成通知由 hook 自動發送
4. **一個 CC session = 一個 step** — 每次都是全新 session

---

## 場景 1：開始新 Story

```
使用者: 開始 US-007

OpenClaw 執行:
  1. orchestrator auto ./go-netagent "US-007"
     → 回傳 { "action": "dispatched", "step": "bdd", "prompt": "You are executing step BDD..." }

  2. bin/dispatch-claude-code.sh \
       -w ./go-netagent \
       -n "US-007-BDD" \
       -c whatsapp \
       --notify-target "+1234567890" \
       -p "$PROMPT"

OpenClaw 回覆使用者:
  「正在執行 US-007 BDD 步驟...」

OpenClaw 之後的行為:
  ❌ 不要讀 .ai/HANDOFF.md
  ❌ 不要讀 .ai/STATE.json
  ❌ 不要發「BDD 完成了！」的訊息
  ✅ 靜默等待 hook 通知（WhatsApp 會自動收到）
```

使用者會收到 hook 的 WhatsApp 通知：
```
✅ US-007-BDD done
Story: US-007
Step: bdd
Status: pass
Files: docs/bdd/US-007.md
```

---

## 場景 2：繼續下一步

```
使用者: 繼續

OpenClaw 執行:
  1. orchestrator auto ./go-netagent "繼續"
     → 回傳 { "action": "dispatched", "step": "sdd-delta", "prompt": "You are executing step SDD Delta..." }

  2. bin/dispatch-claude-code.sh \
       -w ./go-netagent \
       -n "US-007-SDD-Delta" \
       -c whatsapp \
       --notify-target "+1234567890" \
       -p "$PROMPT"

OpenClaw 回覆使用者:
  「正在執行 SDD Delta 步驟...」

OpenClaw 之後: 靜默等待 hook 通知
```

---

## 場景 3：查詢狀態（不啟動 CC）

```
使用者: 目前狀態如何

OpenClaw 執行:
  orchestrator auto ./go-netagent "目前狀態如何"
  → 回傳 { "action": "query", "data": { "step": "impl", "status": "pass", ... } }

  ❌ 不啟動 CC — 這是免費查詢

OpenClaw 回覆使用者:
  「US-007 目前在 impl 步驟，狀態 pass。」
```

---

## 場景 4：自訂任務

```
使用者: 幫我把 console.log 換成 pino

OpenClaw 執行:
  1. orchestrator auto ./go-netagent "幫我把 console.log 換成 pino"
     → 回傳 { "action": "dispatched", "step": "custom", "prompt": "..." }

  2. bin/dispatch-claude-code.sh \
       -w ./go-netagent \
       -n "custom-replace-logger" \
       -c whatsapp \
       --notify-target "+1234567890" \
       -p "$PROMPT"

OpenClaw 回覆使用者:
  「正在執行自訂任務...」

OpenClaw 之後: 靜默等待 hook 通知
```

---

## 場景 5：Review 核准/退回（不啟動 CC）

```
使用者: approve

OpenClaw 執行:
  orchestrator auto ./go-netagent "approve"
  → 回傳 { "action": "approved" }

  ❌ 不啟動 CC

OpenClaw 回覆使用者:
  「已核准，準備進入下一步。要繼續嗎？」
```

```
使用者: reject 需求不清楚

OpenClaw 執行:
  orchestrator auto ./go-netagent "reject 需求不清楚"
  → 回傳 { "action": "rejected" }

OpenClaw 回覆使用者:
  「已退回。原因：需求不清楚。」
```

---

## 場景 6：使用 --from-orchestrator 捷徑

`dispatch-claude-code.sh` 支援 `--from-orchestrator`，會自動呼叫
`orchestrator dispatch` 取得 prompt，省去手動兩步：

```
使用者: 繼續

OpenClaw 執行:
  bin/dispatch-claude-code.sh \
    --from-orchestrator ./go-netagent \
    -n "US-007-$(orchestrator status ./go-netagent | jq -r '.step')" \
    -c whatsapp \
    --notify-target "+1234567890"

  ⚡ 一步完成：取 prompt + 啟動 CC

OpenClaw 回覆使用者:
  「正在繼續 US-007...」

OpenClaw 之後: 靜默等待
```

---

## 場景 7：CC 完成後自動推進

Hook 完成後，如果 OpenClaw 想自動推進到下一步（不等使用者說「繼續」）：

```
[Hook 通知到達: ✅ US-007-BDD done, Status: pass]

OpenClaw 執行:
  1. orchestrator auto ./go-netagent "繼續"
     → 如果回傳 "dispatched" → 自動跑下一步
     → 如果回傳 "needs_human" → 告知使用者需要 review
     → 如果回傳 "done" → 告知使用者 story 完成

  2. 如果是 dispatched:
     bin/dispatch-claude-code.sh \
       -w ./go-netagent \
       -n "US-007-SDD-Delta" \
       -c whatsapp \
       --notify-target "+1234567890" \
       -p "$PROMPT"

OpenClaw 回覆使用者:
  「BDD 通過，自動進入 SDD Delta...」（一句話）

OpenClaw 之後: 靜默等待下一個 hook 通知
```

---

## 時序圖

```
使用者          OpenClaw              dispatch.sh          CC           Hook
  |                |                      |                 |             |
  |-- "開始 US-007" -->                   |                 |             |
  |                |-- orchestrator auto ->|                 |             |
  |                |<- { dispatched, prompt }                |             |
  |                |-- dispatch-claude-code.sh ------------->|             |
  |<-- "正在執行 BDD..." |                |                 |             |
  |                |    (靜默等待)         |                 |-- 執行工作 ->|
  |                |                      |                 |-- HANDOFF --|
  |                |                      |                 |-- exit ---->|
  |                |                      |                 |   Hook fires|
  |                |                      |                 |   apply-handoff
  |                |                      |                 |   build_notify_msg
  |<============= WhatsApp 通知 =====================================|
  |  "✅ US-007-BDD done                  |                 |             |
  |   Story: US-007                       |                 |             |
  |   Step: bdd                           |                 |             |
  |   Status: pass"                       |                 |             |
```

---

## 嚴禁行為

| ❌ 不要做 | ✅ 正確做法 |
|-----------|-----------|
| `claude -p "Use agentic-coding skill to continue..."` | `bin/dispatch-claude-code.sh -p "$PROMPT"` |
| CC 退出後讀 `.ai/HANDOFF.md` | 等 hook 通知或 `pending-wake.json` |
| CC 退出後讀 `.ai/STATE.json` | 用 `orchestrator query` 查詢 |
| 發「XX 步驟完成了，測試 pass=12...」 | 靜默 — hook 已發 WhatsApp |
| 自己組 CC 的 prompt | 用 `orchestrator auto/dispatch` 取得完整 prompt |
| 一個 session 跑多個 step | 每個 step 是獨立的 CC session |

---

## dispatch-claude-code.sh 參數速查

```bash
bin/dispatch-claude-code.sh \
  -w ./project \                          # 專案目錄（必要）
  -p "$PROMPT" \                          # CC 執行的 prompt（或用 --from-orchestrator）
  -n "US-007-BDD" \                       # 任務名稱（顯示在通知裡）
  -c whatsapp \                           # 通知管道
  --notify-target "+1234567890" \        # 通知對象
  --from-orchestrator ./project \         # 自動取 dispatch prompt（替代 -p）
  --permission-mode plan \                # 覆蓋預設權限（預設: --dangerously-skip-permissions）
  --allowed-tools "Read,Write,Edit,Bash"  # 限制 CC 可用工具
```
