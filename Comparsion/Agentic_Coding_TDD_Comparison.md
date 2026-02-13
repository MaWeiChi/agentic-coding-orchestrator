# Agentic Coding Framework — TDD 比較分析

**與 GPT-Pilot Dev Loop、testify patterns、OpenSpec / Spec Kit、Aider Repo Map、MetaGPT Message Pool 的交叉比較**

February 2026

---

## 比較對象一覽

| 框架 / 工具 | 核心定位 | TDD 相關性 |
|-------------|---------|-----------|
| **本框架（Agentic Coding Framework）** | 專案上下文基礎建設 + 微觀瀑布迭代 | 完整 TDD 階段（Test Scaffolding → Implementation → Verify） |
| **GPT-Pilot Dev Loop** | 多 Agent 角色分工的全流程開發工具 | 測試作為 self-correction 回饋，遞迴除錯 |
| **testify patterns** | Go 測試工具鏈 | 實作層級的測試模式（assert/require/suite/mock） |
| **OpenSpec / Spec Kit** | Spec-Driven Development 框架 | 規格先行，測試從規格推導 |
| **Aider Repo Map** | LLM context 壓縮 | 間接：AST 解析讓 agent 更精確理解 codebase |
| **MetaGPT Message Pool** | 多 Agent 協作的訊息過濾 | 間接：解決多 agent 間的 context 隔離問題 |

---

## 1. 開發流程結構比較

### 本框架：巨觀敏捷 × 微觀瀑布

```
Bootstrap（一次性）
  └→ 專案摘要 → 初始 SDD → Internal Interface

每個 User Story（微觀瀑布）
  └→ BDD → SDD Delta → API 契約 → Review Checkpoint → Test Scaffolding → Implementation → Verify → Update Memory
```

核心特徵：Story 之間敏捷（可插入、砍掉、調序），Story 內部嚴格順序。每一步都有明確的輸入輸出，agent 不需做模糊判斷。

### GPT-Pilot：角色分工的線性流程

```
Product Owner（需求釐清）
  → Architect（技術選型）
  → DevOps（環境設定）
  → Tech Lead（任務拆分）
  → Developer（實作描述）→ Code Monkey（寫 code）
  → Reviewer（審查）
  → 遞迴除錯（最多 5 層）
```

核心特徵：每個角色是獨立的 agent，按順序激活。錯誤觸發遞迴除錯迴圈。

### OpenSpec / Spec Kit：規格驅動的階段閘門

**Spec Kit（GitHub）** 採嚴格四階段閘門：

```
Specify（定義 what & why）→ Plan（技術約束）→ Tasks（拆解任務）→ Implement（執行）
```

**OpenSpec** 較寬鬆，每個變更有獨立資料夾（proposal → specs → design → tasks），允許迭代。

### 比較分析

| 維度 | 本框架 | GPT-Pilot | Spec Kit | OpenSpec |
|------|--------|-----------|----------|---------|
| 迭代單位 | User Story | Task（更細粒度） | 整個 Feature | Change（變更） |
| 人類介入點 | Review Checkpoint（BDD+Delta+契約確認後） | 遞迴 5 層後 + 每步可介入 | 每個閘門都需通過 | 較自由 |
| 適合場景 | 中大型專案、持續開發 | 從零建構新專案 | Greenfield 專案 | Brownfield 專案 |
| 增量更新 | Delta Spec 格式 | 無明確機制 | 無（每次重新 Specify） | 每個 Change 獨立資料夾 |

**本框架的獨特優勢：**

- **Delta Spec** 是少數明確定義「如何增量更新設計文件」的機制。GPT-Pilot 和 Spec Kit 都沒有對應概念——它們傾向重新生成而非增量修改，在大型專案中會造成 token 浪費和決策遺失風險。
- **Review Checkpoint 的定位精準**：在 BDD + SDD Delta + 契約三者都就緒後才觸發人類審查，是修改成本最低的時間點。GPT-Pilot 的 Reviewer 在 code 寫完後才介入，回頭改的代價更高。
- **巨觀敏捷層**：GPT-Pilot 缺乏 Story 層級的排序彈性，Spec Kit 的閘門讓 pivot 成本很高。本框架的 Story 獨立性讓戰略調整更靈活。

**本框架可借鑑的地方：**

- **GPT-Pilot 的遞迴除錯深度控制**（最多 5 層）是值得參考的設計。本框架的 TDD self-correction loop 目前沒有定義遞迴上限，可能導致 agent 在某個測試失敗上無限打轉。建議在 Lifecycle 文件中加入類似的上限機制。
- **OpenSpec 的 Brownfield-first 哲學**與本框架的「既有專案流程」呼應。OpenSpec 的「每個 Change 一個資料夾」可作為 Delta Spec 歸檔的參考（目前本框架建議 `docs/deltas/US-XXX.md`，可考慮更結構化的 `changes/US-XXX/` 目錄）。

---

## 2. TDD 機制深度比較

### 本框架的 TDD 設計

```
Test Scaffolding（紅燈）
  ↓ 根據 BDD 標記 + NFR 表格產出測試骨架
  ↓ 所有測試 t.Fatal("Not implemented")
Implementation（綠燈）
  ↓ 寫最少 code 讓測試通過 → Refactor
Verify（品質關卡）
  ↓ Completeness + Correctness + Coherence
  ↓ 三重通過才進入下一步
```

### GPT-Pilot 的測試方式

GPT-Pilot 的測試不是 TDD 模式——它在 code 寫完後補測試，更接近「Implementation → Test → Debug」循環。測試的主要角色是作為 self-correction 的回饋信號，而非需求的前置定義。

### testify patterns 與本框架的對接

本框架指定 Go `testing` + `testify` 作為後端測試工具鏈。以下是 testify 的最佳實踐如何對應到框架各層：

| testify 模式 | 框架對應層 | 用法 |
|-------------|-----------|------|
| `assert`（失敗繼續） | Unit Test 的多重驗證 | BDD 的多個 Then 條件，每個用 assert 驗證 |
| `require`（失敗停止） | 前置條件檢查 | BDD 的 Given 條件，不成立則後續無意義 |
| Table-driven tests | BDD 場景的邊界條件 | 一個 Scenario 的多組輸入輸出 |
| Suite pattern | 跨場景共用 setup | BDD 「前置條件（共用）」段落 |
| Mock（mockery 自動生成） | Integration Test 的依賴隔離 | SDD 模組邊界定義的介面 → 自動生成 mock |

**Test Scaffolding 模板的具體建議：**

```go
// 框架模板中的 t.Fatal("Not implemented — RED phase")
// 建議改為更結構化的寫法：

func TestCartService_GivenEmptyCart_WhenAddItem_ThenCartHasOneItem(t *testing.T) {
    // Given: 空的購物車
    // require 用於前置條件——失敗立即停止
    cart, err := NewCart(userID)
    require.NoError(t, err, "前置條件：建立購物車")
    require.NotNil(t, cart)

    // When: 加入一個商品
    err = cart.AddItem(productID, 1)

    // Then: 購物車有一個商品
    // assert 用於驗證——全部檢查完才報告
    assert.NoError(t, err)
    assert.Equal(t, 1, cart.ItemCount())
    assert.Equal(t, productID, cart.Items()[0].ProductID)
}
```

**NEEDS CLARIFICATION 場景的 testify 實作：**

```go
func TestSearch_GivenQuery_WhenResults_ThenSortedByRelevance(t *testing.T) {
    t.Skip("NEEDS CLARIFICATION: 相關性計算方式未定義")
    // 框架要求用 t.Skip 而非 t.Fatal
    // 這讓測試仍然出現在報告中，但不阻塞 CI
}
```

### Contract-First Testing（Pact 模式）vs. 本框架的 API 契約

本框架使用 OpenAPI / AsyncAPI 作為契約格式，定位是「前後端實作的依據」。Pact 等 Consumer-Driven Contract Testing 工具則從消費者測試中自動生成契約。

兩者的差異：

| 維度 | 本框架（OpenAPI/AsyncAPI） | Pact（Consumer-Driven） |
|------|--------------------------|------------------------|
| 契約產生方式 | 人工 / agent 設計 | 從測試自動生成 |
| 契約時機 | 實作前（Design-First） | 實作後（Code-First） |
| 驗證方式 | agent 對照契約產出 type + test | Provider Verification 自動驗證 |
| 適合場景 | 單團隊 + agent 開發 | 多團隊 microservice |

本框架的 Design-First 方式更適合 Agentic Coding 場景——agent 需要明確的輸入才能產出正確的 code。Pact 的 Code-First 方式在多團隊 microservice 場景更有優勢，但與本框架的「agent 需要先有契約再寫 code」哲學衝突。兩者可以共存：Bootstrap 階段用 Design-First 定義契約，成熟後用 Pact 做跨服務的 regression。

### TDAID（Test-Driven AI Development）vs. 本框架

社群提出的 TDAID 擴展了傳統 TDD 為五階段：Plan → Red → Green → Refactor → Validate。

| TDAID 階段 | 本框架對應 |
|-----------|-----------|
| Plan | BDD + SDD Delta + Review Checkpoint |
| Red | Test Scaffolding |
| Green | Implementation |
| Refactor | Implementation 的一部分 |
| Validate | Verify（Completeness + Correctness + Coherence） |

本框架的 Verify 比 TDAID 的 Validate 更結構化——它明確定義了三個檢查維度和失敗時的回退路徑，而非籠統的「驗證」。

### Context Window 隔離問題

TDD 社群指出一個關鍵問題：**當測試編寫和實作在同一個 context window 中進行時，LLM 會潛意識地讓測試配合計畫中的實作，破壞 TDD 的獨立性。**

本框架透過微觀瀑布的步驟分離部分緩解了這個問題——Test Scaffolding 和 Implementation 是不同步驟。但如果同一個 agent session 連續執行這兩步，context 仍然共享。

可能的改進方向：

- 在 Agent Protocol（待定義）中規定 Test Scaffolding 和 Implementation 使用不同的 session / context
- 或至少要求 agent 在 Test Scaffolding 完成後 commit 並清除 context，再開始 Implementation

---

## 3. 專案狀態管理比較

### 本框架：PROJECT_MEMORY.md

- 純文字檔案，放在專案根目錄
- Git commit hash 校驗機制，跨工具一致性
- 三段式分層載入（機器標記 → 快速定位 → 完整狀態）
- 「事實 vs. 意圖」衝突處理策略
- 工具無關（任何 AI 工具都能讀取）

### GPT-Pilot：SQLite / PostgreSQL

- 資料庫儲存（SQLite 預設，PostgreSQL 可選）
- 對話歷史、agent 決策、專案 metadata
- 與 Git 整合困難（已知限制）
- 工具鎖定（只有 GPT-Pilot 能讀取）

### 比較分析

| 維度 | 本框架（Memory.md） | GPT-Pilot（DB） |
|------|-------------------|-----------------|
| 可攜性 | 極高（純文字 + Git） | 低（需要 GPT-Pilot runtime） |
| 人機共寫 | 原生支援 | 人類無法直接編輯 DB |
| 跨工具 | 任何 AI 工具 | 僅 GPT-Pilot |
| 資訊密度 | 高（壓縮格式省 62% token） | 未最佳化（raw DB records） |
| 歷史追溯 | 最近 5 筆 commit + git log | 完整對話歷史 |

**本框架的優勢**：工具無關 + 人機共寫 + Git 原生整合。這對「今天用 Claude Code、明天用 Cursor、後天用 Copilot」的現實場景非常重要。

**本框架的劣勢**：相比 GPT-Pilot 的 DB，Memory.md 無法記錄完整的對話歷史和 agent 推理過程。如果需要回溯「為什麼 agent 做了這個決定」，Memory.md 的資訊不足。

---

## 4. Context 管理：Aider Repo Map 的啟示

Aider 使用 Tree-sitter 做 AST 解析，產出 Repository Map——一份壓縮版的 codebase 結構，只包含最常被引用的符號（函式簽名、class 定義、type 宣告）。

### 與本框架的關係

本框架的 SDD 某種程度上扮演了類似 Repo Map 的角色——它告訴 agent「系統有哪些模組、各自的介面和依賴」。但兩者的產生方式不同：

| 維度 | SDD（本框架） | Repo Map（Aider） |
|------|-------------|------------------|
| 產生方式 | 人工 / agent 設計 | AST 自動解析 |
| 內容 | 設計意圖 + 模組邊界 | Code 結構 + 符號索引 |
| 更新 | Delta Spec 增量更新 | 每次自動重新生成 |
| 價值 | 「為什麼這樣設計」 | 「現在 code 長什麼樣」 |

兩者互補而非替代。建議在 Agent Protocol 中定義：agent 在 Implementation 階段同時載入 SDD（設計意圖）和 Repo Map（code 現狀），兩份 context 讓 agent 既知道「該做什麼」也知道「現在有什麼」。

### 本框架可借鑑的地方

- **按需載入的 token 最佳化**：Aider 的 Repo Map 根據 context window 剩餘空間動態調整包含的符號數量。本框架的「按需載入」原則（常用放 CLAUDE.md、偶爾需要放獨立檔案）是靜態的。可考慮在 Agent Protocol 中加入動態載入邏輯。
- **AST-aware linting**：Aider 在每次 LLM 編輯後用 Tree-sitter 做 linting。本框架的 Verify 步驟做的是高層級的 Completeness / Correctness / Coherence 檢查，缺少 syntax-level 的即時檢查。建議在 Implementation 迴圈中加入 AST linting。

---

## 5. 多 Agent 協作：MetaGPT Message Pool 的啟示

MetaGPT 的核心設計是 **Global Message Pool + Subscription Mechanism**——agent 發布結構化訊息到共用池，其他 agent 只訂閱自己需要的訊息，避免 context 爆炸。

### 與本框架的關係

本框架目前將 Agent Teams 列為「獨立議題」，不在框架本體中定義。但框架中已有多個與多 agent 協作相關的設計：

- **Bounded Context**（DDD Level 1）：天然的 agent 工作邊界
- **\[P\] 並行標記**：標示可同時進行的子任務
- **Delta Spec + Change Folder**：隔離各 agent 的變更範圍
- **Reference by ID**（待定義）：agent 之間用 NFR ID / Story ID 引用而非重複內容

這些設計與 MetaGPT 的 Message Pool 理念一致——都在解決「多 agent 之間如何高效傳遞 context 而不爆炸」的問題。

### 本框架可借鑑的地方

- **訂閱機制**：目前框架沒有定義「agent A 改了 SDD 的某個模組，agent B 如何知道」。MetaGPT 的訂閱模型可以啟發 Agent Protocol 的設計——例如 agent 只訂閱自己負責的 Bounded Context 的 Delta Spec 變更。
- **結構化通訊 > 自然語言**：MetaGPT 強調 agent 之間用結構化格式（而非自然語言對話）溝通。本框架的 Delta Spec、BDD 標記、NFR ID 已經是結構化的，但尚未定義 agent 之間的交接格式。待定義的 Agent Protocol 應明確規定 YAML 交接格式。

---

## 6. 綜合建議：本框架的強化方向

基於以上比較，以下是本框架可考慮的強化項目，按優先順序排列：

### 高優先（直接提升 TDD 品質）

1. **TDD 遞迴上限**：參考 GPT-Pilot 的 5 層遞迴限制，在 Lifecycle 文件中定義 Implementation self-correction loop 的最大迭代次數。建議 3-5 次，超過則標記 blocker 到 Memory 的 ISSUES 區塊，等人類介入。

2. **testify 模式對接**：在 Templates 文件的 Test Scaffolding 模板中，明確區分 `require`（Given 前置條件）和 `assert`（Then 驗證）的使用場景。加入 Table-driven tests 和 Suite pattern 的模板範例。

3. **AST linting 整合**：在 Implementation 迴圈中加入 syntax-level 的即時檢查（如 `go vet` + `golangci-lint`），作為 Verify 的前置步驟。目前的 Verify 只做高層級檢查，缺少底層的 code quality gate。

### 中優先（強化 context 管理）

4. **動態 context 載入**：參考 Aider Repo Map 的做法，在 Agent Protocol 中定義 agent 在 Implementation 階段如何根據 context window 剩餘空間，動態調整載入的 SDD 段落和 code 範圍。

5. **Test / Implementation context 隔離**：在 Agent Protocol 中建議 Test Scaffolding 和 Implementation 使用不同的 session，或至少在兩步之間執行 commit + context 重置，防止 LLM 潛意識讓測試配合實作。

### 低優先（多 Agent 協作準備）

6. **Agent 訂閱機制**：參考 MetaGPT Message Pool，在 Agent Protocol 中定義 agent 如何訂閱特定 Bounded Context 的變更通知，以及 Delta Spec 的傳播範圍。

7. **YAML 交接格式**：定義 agent 之間的中間產物格式，包含 Story ID、Delta Spec 摘要、測試狀態、blocker 清單。

---

## 附錄：各框架特性對照表

| 特性 | 本框架 | GPT-Pilot | Spec Kit | OpenSpec | Aider | MetaGPT |
|------|--------|-----------|----------|---------|-------|---------|
| TDD 原生支援 | ✅ 完整 | ⚠️ 測試後補 | ❌ 未定義 | ❌ 未定義 | ❌ 非核心 | ❌ 非核心 |
| Test Scaffolding | ✅ BDD 驅動 | ❌ | ❌ | ❌ | ❌ | ❌ |
| Verify 品質關卡 | ✅ 三重檢查 | ⚠️ Reviewer 角色 | ⚠️ 閘門檢查 | ❌ | ❌ | ❌ |
| 增量更新機制 | ✅ Delta Spec | ❌ | ❌ | ⚠️ Change 目錄 | N/A | N/A |
| 跨工具狀態 | ✅ Memory.md | ❌ 工具鎖定 | ❌ | ❌ | N/A | ⚠️ Message Pool |
| NFR 整合 | ✅ ID 系統 | ❌ | ❌ | ❌ | N/A | N/A |
| Context 壓縮 | ⚠️ 靜態分層 | ⚠️ 過濾相關檔案 | N/A | N/A | ✅ AST Repo Map | ✅ 訂閱過濾 |
| 多 Agent 支援 | ⚠️ 待定義 | ✅ 角色分工 | ❌ 單 Agent | ❌ 單 Agent | ❌ 單 Agent | ✅ 原生多 Agent |
| 遞迴除錯限制 | ❌ 未定義 | ✅ 5 層上限 | N/A | N/A | N/A | N/A |
| Brownfield 支援 | ✅ 反向工程流程 | ⚠️ 有限 | ❌ Greenfield 為主 | ✅ 原生 | ✅ Repo Map | ⚠️ 有限 |

---

## 結論

本框架在 TDD 整合的完整度上領先於所有比較對象——它是唯一一個從 BDD 場景標記到 Test Scaffolding 到 Verify 品質關卡有完整鏈路的框架。GPT-Pilot 的測試是「寫完再補」，Spec Kit / OpenSpec 根本不定義測試策略。

框架最大的獨特價值在三個地方：Delta Spec 增量更新（解決 token 浪費和決策遺失）、PROJECT_MEMORY.md 的跨工具狀態追蹤（解決工具鎖定）、以及 BDD 標記驅動的測試金字塔（解決「agent 不知道該寫哪種層級的測試」）。

需要強化的方向主要集中在 context 管理（借鑑 Aider 的動態載入）和多 Agent 協作（借鑑 MetaGPT 的訂閱機制），這些正好是待定義的 Agent Protocol 要處理的範疇。
