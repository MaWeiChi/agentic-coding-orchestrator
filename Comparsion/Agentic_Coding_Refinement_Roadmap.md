# Agentic Coding Framework — 精進建議彙整

**基於 BDD / SDD / TDD / DDD 主流最佳實踐比較分析 | February 2026**

---

## 一、總觀

本文件彙整四份比較分析（BDD / SDD / TDD / DDD）中識別出的所有精進項目，去除重複後歸納為 **30 條建議**，依優先級與主題分類排序，作為下一階段框架迭代的行動清單。

### 框架的三大獨特優勢（四份比較一致確認）

1. **Delta Spec 增量更新格式**——解決 token 浪費和決策遺失，業界無等價物
2. **PROJECT_MEMORY.md 跨工具狀態追蹤**——Git 校驗機制讓多工具協作成為可能
3. **BDD 標記 × NFR ID 雙向連結**——讓非功能性需求不再是 BDD 的盲區

### 主要精進方向（四份比較的共同發現）

1. **「發現流程」空白**——框架假設需求已由人類提供，但未定義如何消費人類的發現成果（Event Storming、Example Mapping）
2. **「視覺化描述」不足**——Mermaid 圖表已在 DDD 中使用，但未延伸到 SDD 的系統架構、資料模型、執行時序
3. **「Agent 自動化驗證」可強化**——Constitution 目前依賴 Agent 自覺，長期需往 CI 自動驗證演進

---

## 二、完整精進清單（30 條）

> 優先級定義：**P0** = 高優先（補強核心實踐）、**P1** = 中優先（擴充能力）、**P2** = 低優先（錦上添花 / 長期演進）

### P0 — 高優先（10 條）

| # | 領域 | 建議項目 | 具體內容 | 影響文件 |
|---|------|---------|---------|---------|
| 1 | BDD | 補充宣告式風格指引 | 在 BDD 撰寫原則中明確「優先使用宣告式 Given/When/Then，避免描述 UI 操作細節」 | Templates → BDD |
| 2 | BDD | 標準化 Background 語法 | 將「前置條件（共用）」改用 Gherkin 標準的 `Background:` 區塊 | Templates → BDD |
| 3 | BDD | 加入 Scenario Outline 範例 | BDD 模板中補充參數化場景的寫法（`Scenario Outline:` + `Examples:` table） | Templates → BDD |
| 4 | BDD | 補充 @wip / @skip 標記 | 與 `[NEEDS CLARIFICATION]` 互補，覆蓋「開發中」和「暫時跳過」的場景 | Templates → BDD |
| 5 | SDD | 補充 System Context 描述 | 在 SDD「系統架構」加入「系統與外部系統的關係」（對應 C4 Level 1），建議用 Mermaid graph | Templates → SDD |
| 6 | SDD | 加入 Mermaid 圖表指引 | 明確建議：系統架構用 `graph`、資料模型用 `erDiagram`、複雜互動用 `sequenceDiagram` | Templates → SDD |
| 7 | SDD | 明確資料模型 Source of Truth | 在 SDD 撰寫原則加入「SDD 是資料模型的唯一真相來源，API schemas 從 SDD 推導」 | Templates → SDD |
| 8 | TDD | TDD 遞迴上限 | 參考 GPT-Pilot 的 5 層限制，定義 Implementation self-correction loop 最大迭代次數（3-5 次），超過則標記 blocker | Lifecycle |
| 9 | TDD | testify 模式對接 | 在 Test Scaffolding 模板中明確區分 `require`（Given）和 `assert`（Then），加入 Table-driven tests 和 Suite pattern | Templates → Test |
| 10 | TDD | AST linting 整合 | 在 Implementation 迴圈加入 syntax-level 即時檢查（`go vet` + `golangci-lint`），作為 Verify 的前置步驟 | Lifecycle |

### P1 — 中優先（12 條）

| # | 領域 | 建議項目 | 具體內容 | 影響文件 |
|---|------|---------|---------|---------|
| 11 | BDD | 輕量版 Example Mapping | 在 Story 啟動時加入結構化的需求發現步驟，用 Rules / Examples / Questions 三分法 | Templates → BDD |
| 12 | BDD | Helper Function 提取原則 | 在 Test Scaffolding 指南加入「多個測試共用相同 Given setup 時應提取為共用函式」 | Templates → Test |
| 13 | BDD | Anti-Pattern 清單 | 列出 Agent 常犯的 BDD 反模式（命令式場景、場景間資料傳遞、incidental details） | Templates → BDD |
| 14 | SDD | 加入 Non-Goals 概念 | 在 BDD 或 Delta Spec 加入可選的 Non-Goals / Out of Scope 段落（參考 Google Design Doc） | Templates → SDD |
| 15 | SDD | 模組錯誤處理策略 | 在 SDD 模組描述加入可選的 Error Handling 欄位（重試、降級、錯誤傳遞） | Templates → SDD |
| 16 | SDD | ADR Status 機制 | 加入 Status 欄位（Proposed / Accepted / Deprecated / Superseded）支援決策演進追蹤 | Templates → SDD |
| 17 | DDD | Event Storming 產出對接指引 | 在 Bootstrap 加入「如何將 Event Storming 結果轉化為 Context Map + BDD 場景」 | Templates → DDD |
| 18 | DDD | Domain Event Registry | 在 DDD 格式指南加入集中事件清單模板，作為 AsyncAPI 的上層索引 | Templates → DDD |
| 19 | DDD | 補充 Context Mapping 模式 | 互動模式表格至少加入 Shared Kernel 和 Conformist 的處理指引 | Templates → DDD |
| 20 | DDD | Subdomain 分類欄位 | Context Map 表格加入「類型（Core / Supporting / Generic）」欄位 | Templates → DDD |
| 21 | TDD | 動態 context 載入 | 參考 Aider Repo Map，定義 agent 在 Implementation 階段如何動態調整載入的 SDD 段落 | Agent Protocol |
| 22 | TDD | Test/Implementation context 隔離 | 建議 Test Scaffolding 和 Implementation 使用不同 session，或中間 commit + context 重置 | Agent Protocol |

### P2 — 低優先（8 條）

| # | 領域 | 建議項目 | 具體內容 | 影響文件 |
|---|------|---------|---------|---------|
| 23 | DDD | Aggregate 設計原則 | 加入「小 Aggregate 原則」「跨 Aggregate 用 Domain Event」「Entity vs. Value Object 判斷」 | Templates → DDD |
| 24 | DDD | Context 演進策略 | 定義何時分裂/合併 Context 的啟發式規則 | Templates → DDD |
| 25 | SDD | Runtime View（執行時序圖） | 對於關鍵場景加入 Mermaid sequenceDiagram 描述模組間時序互動 | Templates → SDD |
| 26 | SDD | Cross-cutting Concerns 段落 | SDD 加入集中描述橫切關注點（日誌、錯誤處理、i18n、快取） | Templates → SDD |
| 27 | SDD | Deployment View（部署視圖） | 當 Agent 需要理解部署拓撲時，加入輕量級部署視圖模板 | Templates → SDD |
| 28 | TDD | Agent 訂閱機制 | 參考 MetaGPT Message Pool，定義 agent 如何訂閱特定 Context 的變更通知 | Agent Protocol |
| 29 | TDD | YAML 交接格式 | 定義 agent 之間的中間產物格式（Story ID、Delta Spec 摘要、測試狀態、blocker） | Agent Protocol |
| 30 | BDD | 多語言 Test Scaffolding 模板 | 目前只有 Go + Playwright，可按需擴充 Python / TypeScript | Templates → Test |

---

## 三、依主題分類解說

### 3.1 BDD 精進（7 條）

框架的 BDD 層在場景粒度控制、測試層級標記、RFC 2119 用語上已超越業界標準，但在 Gherkin 撰寫細節上可吸收成熟 BDD 社群的經驗。

「宣告式風格」是 Cucumber 官方強烈建議的核心原則，框架目前未明確提及。Background 語法、Scenario Outline 和 @wip/@skip 標記是 BDD 工具的基本功能，補充後可讓 Agent 的 BDD 場景更完整。Example Mapping 可作為 Story 啟動前的需求發現工具，填補框架在「發現流程」上的空白。

### 3.2 SDD 精進（8 條）

框架的 SDD 在 Delta Spec 增量更新和 BDD → SDD → API 契約的三層連動上是獨特優勢，但在架構描述完整度上不如 arc42。

最重要的三個補強：System Context（系統與外部世界的關係）、Mermaid 圖表指引（從 DDD 延伸到 SDD）、資料模型 Source of Truth 明確化。Non-Goals 概念參考自 Google Design Doc，可有效防止 Agent 過度延伸 scope。橫切關注點、Runtime View 和 Deployment View 屬於長期演進項目。

### 3.3 TDD 精進（7 條）

框架在 TDD 整合的完整度上領先於所有比較對象，是唯一從 BDD 場景標記到 Test Scaffolding 到 Verify 有完整鏈路的框架。

三個 P0 項目均可直接提升測試品質：TDD 遞迴上限參考 GPT-Pilot 的 5 層限制設計，testify 模式對接讓 Test Scaffolding 更精確，AST linting 填補了 Verify 在 syntax-level 的空白。Agent Protocol 相關的建議（動態 context 載入、context 隔離、訂閱機制、YAML 交接）屬於框架待定義的下一個主題。

### 3.4 DDD 精進（6 條）

框架對 DDD 的處理策略是「萃取精華、按需啟用」，三層漸進式設計大幅降低了 DDD 的導入門檻。

主要精進集中在三個面向：發現流程（Event Storming 產出如何對接框架）、戰術設計深度（Aggregate 設計原則、Domain Event 正式化）、互動模式完整度（補充 Shared Kernel 和 Conformist）。Subdomain 分類在 Agentic Coding 中有實用價值——Agent 可對 Core Domain 投入更多測試覆蓋和設計審查。

### 3.5 跨領域精進（2 條）

Constitution → Fitness Function 的演進路徑是四份比較中反覆出現的共同建議。目前 Constitution 依賴 Agent 的「自覺」，長期應將可程式化的原則轉化為 ArchUnit 規則並整合到 CI。Agent Protocol 作為框架待定義的下一個主題，將消化 TDD 比較中識別出的多條 context 管理相關建議。

---

## 四、建議行動計畫

### Phase 1：P0 高優先（10 條）

直接提升框架核心品質，大多是對現有文件的小幅補充，不涉及架構變更。主要影響 Templates 和 Lifecycle 兩份文件。建議在下一個版本迭代中完成。

### Phase 2：P1 中優先（12 條）

擴充框架能力，部分項目可能需要新增模板段落或指引。DDD 相關項目可在實際專案中碰到資格後再補充。Agent Protocol 相關項目等待下一個討論主題啟動後納入。

### Phase 3：P2 低優先（8 條）

長期演進項目，多數屬於「碰到了再補」的類型，與框架「不用一開始追求完備」的核心原則一致。Constitution → Fitness Function 是其中最有價值的長期投資。

---

## 五、統計摘要

| 維度 | P0 | P1 | P2 | 小計 |
|------|:---:|:---:|:---:|:---:|
| BDD | 4 | 3 | 1 | 8 |
| SDD | 3 | 3 | 3 | 9 |
| TDD | 3 | 2 | 2 | 7 |
| DDD | 0 | 4 | 2 | 6 |
| 跨領域 | 0 | 0 | 0 | 0 |
| **合計** | **10** | **12** | **8** | **30** |

影響文件分佈：Templates 文件受影響最多（25 條），Lifecycle 文件次之（3 條），Agent Protocol（待定義）4 條。**Framework 主文件不需修改。**
