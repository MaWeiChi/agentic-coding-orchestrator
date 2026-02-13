# Agentic Coding Framework × BDD 最佳實踐比較分析

**你的框架 vs. Cucumber / Behave / pytest-bdd / SpecFlow 及 SDD 新興實踐**

---

## 一、定位差異：框架在 BDD 光譜上的位置

傳統 BDD 工具（Cucumber、Behave、pytest-bdd）的定位是 **「從 Gherkin 到可執行測試」的自動化橋樑**——它們解決的是「怎麼讓 Given/When/Then 跑起來」。

你的 Agentic Coding Framework 的定位更高一層：**「從需求到可交付軟體」的 AI 協作流程**——BDD 只是其中第二層，往上有專案摘要和 Memory，往下有 SDD、API 契約、TDD、Verify。

這意味著傳統 BDD 工具是你框架的 **子集**，而非競爭者。比較的重點不在「誰的 Gherkin 寫法比較好」，而在「你的框架在 BDD 的基礎上額外做了什麼、又遺漏了什麼」。

| 面向 | 傳統 BDD 工具 | Agentic Coding Framework |
|------|--------------|--------------------------|
| 核心使命 | 行為規格 → 可執行測試 | 專案上下文 → AI 可理解的開發藍圖 |
| 消費者 | 人類開發者 + CI runner | AI Agent + 人類團隊 |
| 涵蓋範圍 | 需求 → 測試 | 需求 → 架構 → 契約 → 測試 → 實作 → 驗證 |
| 執行引擎 | Step definition runtime | Agent 的微觀瀑布循環 |

---

## 二、BDD 場景撰寫：逐項比較

### 2.1 Gherkin 語法與風格

**業界共識（Cucumber 官方 + 社群）：**

- 宣告式（Declarative）優於命令式（Imperative）：寫「Given 使用者已登入」而非「Given 使用者在登入頁 → When 輸入帳密 → When 點擊登入按鈕」
- 一個場景驗證一件事（One Scenario = One Behavior）
- 步驟數保持個位數（< 10 步）
- Then 不超過 3 條，超過就拆場景
- 使用領域語言，不用技術術語

**你的框架：**

- ✅ 明確要求「一個場景驗證一件事」、「Then 超過三條就拆分」
- ✅ 要求「使用領域語言，不用技術術語」
- ✅ 「Given 描述狀態、When 描述動作、Then 描述結果」的分工規則
- ⚠️ 未明確區分宣告式 vs. 命令式風格——建議在 BDD 撰寫原則中補充「優先使用宣告式描述」

**結論：** 你的框架在場景粒度控制上與業界一致，但可以更明確地強調宣告式風格。

### 2.2 標記系統（Tagging）

**業界做法：**

| 工具 | 標記語法 | 用途 |
|------|---------|------|
| Cucumber | `@smoke`, `@regression`, `@wip` | CI 階段篩選、排除未完成場景 |
| Behave | 同上 + `before_tag()` hooks | 標記驅動 setup/teardown |
| pytest-bdd | `@pytest.mark.*` 整合 | 與 pytest 標記系統互通 |

**你的框架：**

- ✅ 測試層級標記（`@unit`, `@integration`, `@component`, `@e2e`）——比業界更精細，直接對應測試金字塔
- ✅ 帶 ID 標記（`@perf(PERF-01)`, `@secure(SEC-01)`）——**這是你框架的獨創設計**，業界沒有對應物
- ✅ 標記驅動 CI 觸發時機（PR → `@unit`+`@integration`+`@component`；Merge → 加 `@e2e`）
- ⚠️ 缺少 `@wip`（work in progress）和 `@skip` 等流程控制標記——`[NEEDS CLARIFICATION]` 部分覆蓋了這個需求，但語意不同

**結論：** 你的標記系統在「測試層級」和「NFR 連結」兩個維度上**超越業界標準**。帶 ID 標記讓 NFR 不再是 BDD 的盲區，這是傳統工具做不到的。建議補充 `@wip` 等流程標記以完善日常開發需求。

### 2.3 RFC 2119 用語強度

**業界做法：** Cucumber/Behave/pytest-bdd 均**不使用** RFC 2119 關鍵字。Gherkin 場景預設所有 Then 都是硬性要求——如果有場景不重要，就不寫場景。

**你的框架：**

- ✅ 引入 `SHALL/MUST`（硬性）、`SHOULD`（建議）、`MAY`（可選）區分需求強度
- ✅ Agent 行為規則明確：`SHALL` 必須實作、`SHOULD` 跳過需記 ADR、`MAY` 自行判斷

**結論：** 這是為 AI Agent 量身設計的創新。人類開發者不需要這種區分（直覺就能判斷），但 Agent 需要明確的優先級信號。在傳統 BDD 工具中沒有對應概念。

### 2.4 不確定性處理

**業界做法：** Cucumber 的 `@wip` 標記用於未完成場景，但沒有「需求不確定」的標準處理方式。Discovery Workshop / Example Mapping 是在寫場景前就解決不確定性的——如果需求不清楚，根本不寫場景。

**你的框架：**

- ✅ `[NEEDS CLARIFICATION]` 標記允許 Agent 在需求模糊時**標記而非猜測**
- ✅ 測試骨架仍產出但用 `t.Skip("NEEDS CLARIFICATION")` 而非 `t.Fatal`
- ✅ 在 Memory 的 ISSUES 追蹤待釐清項目
- ✅ Review Checkpoint 時集中釐清

**結論：** 業界用 Discovery Workshop 前置解決不確定性；你的框架允許 Agent 帶著不確定性往前走，在 Review Checkpoint 再回頭釐清。兩者策略不同但各有道理——Agent 不能「開會」，所以標記+暫停是合理的替代方案。**建議考慮在框架中加入 Example Mapping 的輕量版**，讓人類在寫 BDD 前有結構化的發現流程。

---

## 三、測試策略比較

### 3.1 測試金字塔

**業界標準（Mike Cohn 原版 + 現代演進）：**

```
        E2E（少）
       Integration（適中）
      Unit（大量）
```

**你的框架擴充為五層：**

```
        Full E2E（跨 Story 里程碑）
       Component Test（Story 內，前端）
      API Integration（Story 內，後端）
     Unit Test（Story 內，快速迴圈）
    Performance / Load（NFR 驅動）
```

**比較：**

- ✅ Component Test 獨立為一層是正確的——Playwright component testing 的隔離特性值得獨立對待
- ✅ Performance/Load 不在金字塔內而是「旁路」，由 NFR 標記觸發——這比業界「效能測試放哪裡」的模糊態度更清楚
- ✅ 明確定義每一層的工具鏈（Go testing + testify / httptest / Playwright / k6）

**結論：** 你的五層金字塔比業界三層更精確，特別是 Component Test 和 NFR 測試的定位非常清楚。

### 3.2 TDD 與 BDD 的整合

**業界做法：** BDD 和 TDD 通常是兩個獨立的實踐。BDD 場景寫在 `.feature` 檔案中，透過 step definition 連結到測試程式碼。TDD 是開發者在寫單元測試時的紅-綠-重構循環。兩者的連結點模糊。

**你的框架：**

- ✅ **Test Scaffolding（紅燈）→ Implementation（綠燈）→ Verify** 三步驟明確串聯 BDD 和 TDD
- ✅ BDD 場景的標記直接驅動 Test Scaffolding 產出哪些層級的測試——這是自動化的連結，不是人為約定
- ✅ Verify 步驟的三重檢查（Completeness / Correctness / Coherence）確保 BDD 場景和實作不脫鉤

**結論：** 你的框架解決了業界長期存在的「BDD 和 TDD 怎麼接起來」的問題。關鍵在於 **BDD 標記 → Test Scaffolding 的自動推導**——這在傳統工具中需要人類手動維護，你的框架讓 Agent 自動完成。

### 3.3 Step Definition / 測試實作

**業界做法（Cucumber）：**
```ruby
Given('a user is logged in') do
  @user = create(:user)
  login_as(@user)
end
```

**業界做法（pytest-bdd）：**
```python
@given('a user is logged in')
def logged_in_user(user_fixture):
    return user_fixture
```

**你的框架：**
```go
func TestXxx_GivenCondition_WhenAction_ThenResult(t *testing.T) {
    // Given: <從 BDD 場景複製的前置條件>
    // When: <從 BDD 場景複製的操作>
    // Then: <從 BDD 場景複製的預期結果>
    t.Fatal("Not implemented — RED phase")
}
```

**比較：**

- 傳統工具：Gherkin → Step Definition → 測試程式碼（三層映射）
- 你的框架：Gherkin → 測試骨架（直接映射，Agent 填充實作）
- ⚠️ 你的框架**跳過了 Step Definition 層**，Agent 直接從 BDD 場景產出測試函式。這在 Agent 驅動的開發中是合理的（Agent 不需要 step reusability），但意味著**同一個 Given 條件在不同場景中可能產出重複的 setup code**
- 💡 建議：保留 BDD 場景的可追溯性（已做到），但在 Test Scaffolding 指南中加入 **helper function 提取原則**——當多個測試骨架共用相同的 Given setup 時，Agent 應提取為共用函式

---

## 四、框架層級比較

### 4.1 你的框架有、BDD 工具沒有的

| 能力 | 說明 | 業界最接近的替代 |
|------|------|------------------|
| **專案摘要（Why/Who/What）** | Agent 快速定位專案核心 | README.md（非結構化） |
| **PROJECT_MEMORY** | 跨工具、跨 session 的動態狀態追蹤 | 無直接對應物 |
| **SDD + Delta Spec** | 架構文件的增量更新機制 | Architecture Decision Records（只記決策，不記全貌） |
| **API 契約（OpenAPI/AsyncAPI）** | 機器可讀的介面定義 | Consumer-Driven Contract Testing（Pact） |
| **Review Checkpoint** | 人類在實作前的審查點 | Pull Request Review（但在實作後） |
| **Verify 三重檢查** | Agent 自動品質關卡 | CI pipeline checks（但不檢查文件一致性） |
| **Constitution** | 不可違反的架構原則 | Architectural Fitness Functions（但需要程式化實作） |
| **DDD 整合** | Bounded Context / Ubiquitous Language | 業界有 DDD+BDD 的實踐，但沒有標準化的整合模板 |
| **NFR ID 系統** | BDD 標記直接引用 NFR 閾值 | 無直接對應物——NFR 通常與 BDD 分離處理 |

### 4.2 BDD 工具有、你的框架可能需要補充的

| 能力 | 業界做法 | 你的框架現況 | 建議 |
|------|---------|-------------|------|
| **Discovery Workshop / Example Mapping** | 寫場景前的結構化需求發現 | 未涵蓋（假設需求已由人類提供） | 在 Bootstrap 或 Story 啟動階段加入輕量版 Example Mapping 指引 |
| **Step Definition 複用** | 跨場景共用 Given/When/Then 實作 | Agent 直接產出測試骨架，無複用層 | 加入 helper function 提取原則 |
| **Scenario Outline + Data Table** | 參數化場景，一個模板多組資料 | 模板中未提及 | 在 BDD 模板中補充 Scenario Outline 範例 |
| **Background 共用前置條件** | Feature 檔案內的共用 Given | 模板中有「前置條件（共用）」段落但非標準 Gherkin 語法 | 改用標準 `Background:` 語法 |
| **Living Documentation 生成** | Cucumber Studio / Pickles / Cukedoctor 自動從 feature 檔生成文件 | BDD 場景本身就是文件，但沒有自動生成機制 | 低優先級——Agent 本身就能讀 BDD 場景，Living Doc 主要服務非技術利害關係人 |
| **Hook 機制** | before_scenario / after_scenario 等生命週期鉤子 | Verify 步驟覆蓋了 after 的驗證功能；before 由 Memory 讀取覆蓋 | 不需額外補充——框架的生命週期管理透過微觀瀑布實現 |
| **宣告式 vs. 命令式風格指引** | Cucumber 官方強烈建議宣告式 | 未明確提及 | 在 BDD 撰寫原則中補充 |

---

## 五、與新興 SDD 框架的比較

你的框架在 Changelog v0.13 中提到「吸收 OpenSpec / Spec Kit 設計」。以下是更細緻的比較：

### 5.1 OpenSpec

**定位：** 輕量級、專注 brownfield（既有專案），強調 token 效率。

| 面向 | OpenSpec | 你的框架 |
|------|---------|----------|
| 規格深度 | 輕量，夠用就好 | 多層（BDD + SDD + 契約 + NFR） |
| 適用場景 | 既有大型 codebase 加功能 | 新舊專案皆適用 |
| Token 意識 | 核心設計原則 | 同樣是核心原則（Memory 壓縮 62% token） |
| NFR 處理 | 不涵蓋 | 完整 NFR ID 系統 |

**結論：** OpenSpec 更「輕」，你的框架更「完整」。兩者的 token 意識相近。

### 5.2 GitHub Spec Kit

**定位：** 企業級、工作流程標準化（Specification → Plan → Tasks → Implementation）。

| 面向 | Spec Kit | 你的框架 |
|------|---------|----------|
| 工作流 | Spec → Plan → Tasks → Impl | Summary → BDD → SDD → 契約 → Review → TDD → Impl → Verify |
| 工具整合 | CLI + 模板 + prompt | 文件模板 + Agent 指引 |
| Review 機制 | 內建 | Review Checkpoint |
| Delta/增量 | 有 | Delta Spec 格式 |

**結論：** 兩者的流程高度相似。你的框架多了 NFR、DDD、Constitution 等可選擴充，適合更複雜的專案。Spec Kit 的優勢在工具鏈整合（CLI），你的框架的優勢在流程完整度。

### 5.3 你的框架的獨特價值

在 OpenSpec、Spec Kit、BMAD-METHOD 等新興框架中，你的框架有幾個**獨特的設計**：

1. **PROJECT_MEMORY + Git 校驗**：跨工具的狀態追蹤是其他框架都沒有的。這解決了「Agent A 改了東西，Agent B 不知道」的協作問題。
2. **BDD 標記 × NFR ID 的雙向連結**：讓非功能性需求不再是 BDD 的盲區。
3. **Verify 三重檢查**：不只驗正確性，還驗完整性和一致性——這是其他框架停留在「測試通過就好」的地方你往前走了一步。
4. **Constitution（專案憲法）**：比 ADR 更強的架構保護機制，防止 Agent 好心破壞設計。
5. **巨觀敏捷 × 微觀瀑布**：清楚定義了 Story 之間和 Story 內部的不同治理模式。

---

## 六、具體建議

### 高優先級（補強 BDD 核心實踐）

1. **補充宣告式風格指引**：在 BDD 撰寫原則中明確「優先使用宣告式 Given/When/Then，避免描述 UI 操作細節」
2. **加入 Scenario Outline 範例**：BDD 模板中補充參數化場景的寫法，讓 Agent 知道何時該用 data table
3. **標準化 Background 語法**：將「前置條件（共用）」改為 Gherkin 標準的 `Background:` 區塊
4. **補充 `@wip` / `@skip` 標記**：與 `[NEEDS CLARIFICATION]` 互補，覆蓋「開發中」和「暫時跳過」的場景

### 中優先級（擴充框架能力）

5. **輕量版 Example Mapping**：在 Story 啟動時加入結構化的需求發現步驟，用 Rules / Examples / Questions 三分法整理場景
6. **Helper Function 提取原則**：在 Test Scaffolding 指南中說明「當多個測試共用相同 Given setup 時，應提取為共用函式」
7. **Anti-Pattern 清單**：列出 Agent 常犯的 BDD 反模式（命令式場景、場景間資料傳遞、incidental details）

### 低優先級（錦上添花）

8. **Living Documentation 生成**：考慮是否需要從 BDD 場景自動生成非技術人員可讀的文件
9. **多語言 Test Scaffolding 模板**：目前只有 Go + Playwright，可按需擴充 Python / TypeScript 等
10. **Consumer-Driven Contract Testing**：在微服務場景中，考慮用 Pact 等工具補充 API 契約的驗證層

---

## 七、總結

你的 Agentic Coding Framework 本質上是 **BDD 的超集**——它保留了 BDD 的核心價值（行為規格作為需求和測試的共同語言），然後在三個方向上大幅擴展：

1. **向上擴展**：專案摘要、Memory、Constitution 提供了 BDD 場景之上的專案級上下文
2. **向下擴展**：SDD、API 契約、Delta Spec 連結了 BDD 場景到具體的架構實作
3. **橫向擴展**：NFR ID 系統、DDD 整合、Verify 三重檢查解決了傳統 BDD 的已知盲區

與傳統 BDD 工具的最大差異在於**消費者不同**：Cucumber 的消費者是人類開發者和 CI runner；你的框架的消費者是 AI Agent。這個根本差異導致了幾個合理的設計偏離（RFC 2119 用語、`[NEEDS CLARIFICATION]` 標記、跳過 Step Definition 層），這些都不是「違反最佳實踐」，而是「為不同消費者最佳化」。

需要加強的部分主要集中在 BDD 場景撰寫的細節指引（宣告式風格、Scenario Outline、Background 語法）——這些是成熟 BDD 社群幾十年經驗的結晶，值得直接吸收。
