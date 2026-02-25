# OpenClaw Dispatch 範例

OpenClaw 使用 agentic-coding-orchestrator (ACO) 驅動 Claude Code (CC)
完成 ACF 專案的完整流程。

## 核心原則

1. **OpenClaw 不直接操作 CC** — 透過 `dispatch-claude-code.sh` 或 `orchestrator auto`
2. **OpenClaw 不自己讀 HANDOFF.md** — 等 hook 通知，避免 race condition
3. **OpenClaw 只發一句 dispatch 確認** — 完成通知由 hook 自動發送
4. **一個 CC session = 一個 step** — 每次都是全新 session
5. **不要捏造結果** — `dispatched` 代表「已派發」不是「已完成」，必須等 hook 通知
6. **遵守 `caller_instruction`** — 每個回傳都帶有明確的下一步指示，照做就好

---

## 場景 1：開始新 Story（推薦：--from-orchestrator）

```
使用者: 開始 US-007

OpenClaw 執行:
  1. orchestrator auto ./go-netagent "US-007"
     → 回傳 {
         "action": "dispatched",
         "step": "bdd",
         "next_step": "sdd-delta",
         "prompt": "You are executing step BDD...",
         "caller_instruction": "Task has been DISPATCHED but is NOT yet complete. You MUST wait..."
       }

  2. dispatch-claude-code.sh \
       --from-orchestrator ./go-netagent \
       -c whatsapp \
       --notify-target "+1234567890"

     ⚡ --name 不需要傳，script 自動從 STATE 生成 "US-007-bdd"

OpenClaw 回覆使用者:
  「正在執行 US-007 BDD 步驟，下一步是 sdd-delta。」

OpenClaw 之後的行為:
  ❌ 不要讀 .ai/HANDOFF.md
  ❌ 不要讀 .ai/STATE.json
  ❌ 不要發「BDD 完成了！」的訊息（你不知道結果，不要捏造）
  ✅ 靜默等待 hook 通知（WhatsApp 會自動收到）
```

使用者會收到 hook 的 WhatsApp 通知：
```
✅ US-007-bdd done
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
     → 回傳 {
         "action": "dispatched",
         "step": "sdd-delta",
         "next_step": "contract",
         "prompt": "You are executing step SDD Delta...",
         "caller_instruction": "Task has been DISPATCHED but is NOT yet complete..."
       }

  2. dispatch-claude-code.sh \
       --from-orchestrator ./go-netagent \
       -c whatsapp \
       --notify-target "+1234567890"

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
  → 回傳 {
      "action": "query",
      "data": {
        "step": "impl",
        "status": "pass",
        "next_step": "verify",
        "last_error": null,
        ...
      }
    }

  ❌ 不啟動 CC — 這是免費查詢

OpenClaw 回覆使用者:
  「US-007 目前在 impl 步驟，狀態 pass，下一步是 verify。」
```

---

## 場景 4：自訂任務

```
使用者: 幫我把 console.log 換成 pino

OpenClaw 執行:
  1. orchestrator auto ./go-netagent "幫我把 console.log 換成 pino"
     → 回傳 {
         "action": "dispatched",
         "step": "custom",
         "next_step": "update-memory",
         "prompt": "...",
         "caller_instruction": "Task has been DISPATCHED but is NOT yet complete..."
       }

  2. dispatch-claude-code.sh \
       --from-orchestrator ./go-netagent \
       -c whatsapp \
       --notify-target "+1234567890"

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

## 場景 6：CC 完成後自動推進

Hook 完成後，如果 OpenClaw 想自動推進到下一步（不等使用者說「繼續」）：

```
[Hook 通知到達: ✅ US-007-bdd done, Status: pass]

OpenClaw 執行:
  dispatch-claude-code.sh \
    --from-orchestrator ./go-netagent \
    -c whatsapp \
    --notify-target "+1234567890"

  script 會自動：
    1. orchestrator dispatch → 拿到 sdd-delta 的 prompt
    2. orchestrator status → 自動生成 task name "US-007-sdd-delta"
    3. 啟動 CC 執行
    4. 等 CC 完成 → apply-handoff

OpenClaw 回覆使用者:
  「BDD 通過，自動進入 SDD Delta...」（一句話）

OpenClaw 之後: 靜默等待下一個 hook 通知
```

---

## 場景 7：CC crash / token 超限（錯誤處理）

```
[CC session 異常退出: API Error: output token limit exceeded]

dispatch-claude-code.sh 會：
  1. 偵測到 exit_code ≠ 0
  2. task-meta.json status 設為 "failed"
  3. hook 觸發 → apply-handoff 找不到 HANDOFF → STATE 標記 failing + last_error

OpenClaw 查詢狀態:
  orchestrator auto ./go-netagent "狀態"
  → 回傳 {
      "action": "query",
      "data": {
        "step": "impl",
        "status": "failing",
        "last_error": "No HANDOFF.md found after executor completed step \"impl\". Executor may have crashed or exceeded token limits.",
        ...
      }
    }

OpenClaw 回覆使用者:
  「impl 步驟失敗了：CC 可能 crash 或超過 token 限制。要重試嗎？」

外部也可以主動回報錯誤:
  orchestrator report-error ./go-netagent "CC session crashed: output token limit exceeded"
```

---

## 場景 8：已完成的 Story 被重啟（防護）

```
[US-007 已完成: step = "done"]

OpenClaw 執行:
  orchestrator auto ./go-netagent "US-007"
  → 回傳 { "action": "error", "message": "Story US-007 is already completed (step: \"done\"). Use --force to restart it, or start a different story." }

OpenClaw 回覆使用者:
  「US-007 已經完成了。你要開新的 story，還是要強制重跑？」

如果要強制重跑（僅限 CLI）:
  orchestrator start-story ./go-netagent US-007 --force
```

---

## 場景 9：任務已在執行中（防護）

```
OpenClaw 執行:
  orchestrator auto ./go-netagent "繼續"
  → 回傳 {
      "action": "already_running",
      "step": "impl",
      "elapsed_min": 3.2,
      "last_error": null,
      "caller_instruction": "A task is already running. Do NOT dispatch again. Wait for the current execution to complete."
    }

OpenClaw 回覆使用者:
  「impl 步驟正在執行中（已跑 3 分鐘），請等待完成。」

  ❌ 不要再 dispatch
```

---

## 場景 10：Rollback 到前一步（v0.6.0）

```
使用者: impl 的方向不對，退回 sdd-delta 重新設計

OpenClaw 執行:
  orchestrator rollback ./go-netagent sdd-delta
  → 回傳（stdout）:
    Rolled back to step "sdd-delta" (status: pending, attempt: 1)

  ❌ 不啟動 CC — rollback 只是重設 STATE
  ✅ 之後使用者說「繼續」時才 dispatch

OpenClaw 回覆使用者:
  「已退回到 sdd-delta 步驟。要繼續嗎？」
```

如果要退回到 bootstrap（需要 --force）：
```
orchestrator rollback ./go-netagent bootstrap --force
```

---

## 場景 11：Pre-Dispatch 發現缺檔（v0.6.0）

```
[dispatch 時自動檢查 claude_reads 檔案是否存在]

orchestrator dispatch ./go-netagent
  → dispatch prompt 末尾會多出：

    === WARNING: MISSING PREREQUISITE FILES ===
    - Missing prerequisite: docs/bdd/US-007.md
    Suggested action: orchestrator rollback bdd
    You may need to produce these files as part of your work,
    or alert the human if they should have been created in a prior step.
    =============================================

  ⚡ 注意：這是 warn-only，dispatch 不會被阻擋
  ⚡ CC 會看到 WARNING，可以自行處理或回報

獨立檢查（不 dispatch）:
  orchestrator check-prereqs ./go-netagent
  → 回傳 JSON: { ok: false, missing: [...], warnings: [...], suggested_rollback: "bdd" }

OpenClaw 可以：
  1. 直接讓 CC 執行（它會看到 WARNING）
  2. 或先 rollback 再重新 dispatch
```

---

## 場景 12：Checklist 自動產生（v0.6.0）

```
使用者: 開始 US-008

OpenClaw 執行:
  orchestrator auto ./go-netagent "US-008"
  → startStory() 自動產生 .ai/CHECKLIST.md：

    # Checklist: US-008
    > Auto-generated by ACO. Executor MUST check off items as they are completed.

    ## BDD
    - [ ] All scenarios written with Given/When/Then
    - [ ] All scenarios tagged with test level
    ...

    ## Implementation
    - [ ] All tests pass (GREEN)
    - [ ] Only affected files modified (Diff-Only)
    ...

  ⚡ 每次 dispatch 的 prompt 末尾都會提醒 CC 更新 checklist
  ⚡ 開發人員隨時可以打開 .ai/CHECKLIST.md 查看進度

使用者: 目前 checklist 如何？
OpenClaw 執行:
  cat ./go-netagent/.ai/CHECKLIST.md
  ❌ 不啟動 CC — 直接讀檔即可

OpenClaw 回覆使用者:
  「US-008 的 checklist：BDD ✅ 全部完成，SDD Delta ✅，目前在 scaffold...」
```

---

## orchestrator auto 回傳速查

| action | 意義 | OpenClaw 該做什麼 |
|--------|------|-----------------|
| `dispatched` | 任務已派發，CC 尚未完成 | 呼叫 `dispatch-claude-code.sh`，然後靜默等待 |
| `done` | Story 已全部完成 | 告知使用者，不需要再 dispatch |
| `needs_human` | 需要人工 review | 展示 review 資訊，等使用者 approve/reject |
| `blocked` | 步驟被阻擋 | 告知使用者阻擋原因 |
| `already_running` | CC 正在執行 | 等待，不要重複 dispatch |
| `timeout` | CC 執行超時 | 告知使用者，等指示是否 retry |
| `query` | 狀態查詢結果 | 顯示給使用者（免費，不啟動 CC） |
| `approved` | Review 已核准 | 告知使用者，可以繼續 |
| `rejected` | Review 已退回 | 告知使用者 |
| `error` | 操作失敗 | 顯示錯誤訊息 |

所有 action 都帶 `caller_instruction` 欄位（dispatched/done/needs_human/blocked/already_running/timeout），OpenClaw 應該遵守其中的指示。

---

## 時序圖

```
使用者          OpenClaw              dispatch.sh          CC           Hook
  |                |                      |                 |             |
  |-- "開始 US-007" -->                   |                 |             |
  |                |-- orchestrator auto ->|                 |             |
  |                |<- { dispatched,       |                 |             |
  |                |    next_step,         |                 |             |
  |                |    caller_instruction }                 |             |
  |                |                      |                 |             |
  |                |-- dispatch-claude-code.sh ------------->|             |
  |                |   (--from-orchestrator)                 |             |
  |                |   (auto task name: US-007-bdd)          |             |
  |<-- "正在執行 BDD..." |                |                 |             |
  |                |    (靜默等待)         |                 |-- 執行工作 ->|
  |                |                      |                 |-- HANDOFF --|
  |                |                      |                 |-- exit ---->|
  |                |                      |                 |   Hook fires|
  |                |                      |                 |   apply-handoff
  |                |                      |                 |   build_notify_msg
  |<============= WhatsApp 通知 =====================================|
  |  "✅ US-007-bdd done                  |                 |             |
  |   Story: US-007                       |                 |             |
  |   Step: bdd                           |                 |             |
  |   Status: pass"                       |                 |             |
```

---

## 嚴禁行為

| ❌ 不要做 | ✅ 正確做法 |
|-----------|-----------|
| `claude -p "Use agentic-coding skill to continue..."` | `dispatch-claude-code.sh --from-orchestrator ./project` |
| CC 退出後讀 `.ai/HANDOFF.md` | 等 hook 通知或 `pending-wake.json` |
| CC 退出後讀 `.ai/STATE.json` | 用 `orchestrator auto "狀態"` 查詢 |
| 發「XX 步驟完成了，測試 pass=12...」 | 靜默 — hook 已發 WhatsApp |
| 自己組 CC 的 prompt | 用 `orchestrator auto/dispatch` 取得完整 prompt |
| 一個 session 跑多個 step | 每個 step 是獨立的 CC session |
| 收到 `dispatched` 就當作完成 | `dispatched` = 已派發，不是已完成 |
| 自己猜測/捏造完成結果 | 等 hook 通知，或查 `orchestrator auto "狀態"` |
| 手動組 `--name` task name | 用 `--from-orchestrator`，script 自動生成 |
| 手動修改 `.ai/STATE.json` 退回步驟 | 用 `orchestrator rollback ./project <step>` |
| 忽略 dispatch prompt 中的 WARNING | 提醒使用者有缺檔，建議 rollback 或繼續 |

---

## dispatch-claude-code.sh 參數速查

```bash
# 推薦用法（最簡單）
dispatch-claude-code.sh \
  --from-orchestrator ./project \       # 自動取 prompt + 自動生成 task name
  -c whatsapp \                         # 通知管道
  --notify-target "+1234567890"       # 通知對象

# 完整參數
dispatch-claude-code.sh \
  -w ./project \                        # 專案目錄（--from-orchestrator 時自動設定）
  -p "$PROMPT" \                        # CC 執行的 prompt（或用 --from-orchestrator）
  -n "US-007-BDD" \                     # 任務名稱（--from-orchestrator 時自動生成）
  -c whatsapp \                         # 通知管道
  --notify-target "+1234567890" \     # 通知對象
  --from-orchestrator ./project \       # 自動取 dispatch prompt（替代 -p）
  --permission-mode bypassPermissions \ # 覆蓋預設權限（預設: --dangerously-skip-permissions）
  --allowed-tools "Read,Write,Edit,Bash" # 限制 CC 可用工具
```
