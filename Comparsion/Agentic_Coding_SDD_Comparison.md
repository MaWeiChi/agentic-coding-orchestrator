# Agentic Coding Framework × SDD 最佳實踐比較分析

**你的框架 vs. IEEE 1016 / arc42 / C4 Model / Google Design Docs / 新興 AI-Driven Spec 框架**

---

## 一、定位差異：框架在 SDD 光譜上的位置

傳統 SDD 標準（IEEE 1016、arc42）的定位是 **「完整描述軟體架構設計」的文件規範**——它們解決的是「怎麼把設計決策寫清楚讓人看懂」。

你的 Agentic Coding Framework 的定位是 **「讓 AI Agent 能理解並執行的架構藍圖」**——SDD 只是其中第三層，往上有專案摘要、Memory、BDD 定義行為預期，往下有 API 契約、TDD、Verify 三重驗證。SDD 不是獨立的文件，而是整個 Agent 工作流中的一個節點。

這意味著傳統 SDD 標準關注的是 **文件的完整性與可讀性**，你的框架關注的是 **文件的可消費性與增量可維護性**。

| 面向 | 傳統 SDD 標準 | Agentic Coding Framework |
|------|--------------|--------------------------|
| 核心使命 | 完整描述架構設計 | 給 Agent 足夠的上下文做出正確實作 |
| 消費者 | 人類架構師 + 開發者 + 利害關係人 | AI Agent + 人類團隊 |
| 文件粒度 | 一份大文件涵蓋全部 | 分層（Summary → BDD → SDD → 契約），按需載入 |
| 更新方式 | 整份修訂（版本號） | Delta Spec 增量更新（ADDED/MODIFIED/REMOVED） |
| 與實作的關係 | 描述性（寫完給人看） | 驅動性（Agent 根據 SDD 產出程式碼） |

---

## 二、架構描述方式：逐項比較

### 2.1 文件結構與組織

**業界標準：**

| 標準/工具 | 結構 | 章節數 | 特色 |
|-----------|------|--------|------|
| IEEE 1016 | 正式、分節式 | 7+ 固定章節 | 嚴謹但僵化，最後修訂 2009 年 |
| arc42 | 12 個固定 section | 12 | 最完整的模板，社群活躍 |
| C4 Model | 4 層抽象 | 不固定 | 視覺優先，不強制文件格式 |
| Google Design Doc | 非正式敘事 | 5-15 頁 | 強調「為什麼」而非「是什麼」 |
| Amazon 6-pager | 6 頁敘事 | 6 固定章節 | 強制會議前靜讀 |

**你的框架：**

- ✅ SDD 模板有明確結構（系統架構、模組劃分、資料模型、技術決策、跨模組互動）
- ✅ 比 Google Design Doc 更結構化，比 IEEE 1016 更輕量
- ✅ 模組導向的劃分方式讓增量更新範圍容易界定
- ⚠️ 未涵蓋 arc42 的某些面向：部署視圖（Deployment View）、品質場景（Quality Scenarios）、技術債務追蹤
- ⚠️ 未提供 C4 的分層抽象指引——系統層級和模組層級的區分不夠明確

**結論：** 你的 SDD 模板在「Agent 可消費性」上優於所有傳統標準（結構清楚、增量友善），但在「架構描述完整度」上不如 arc42。這是合理的取捨——Agent 不需要 12 個 section 的完整 arc42 文件，但**部署視圖和品質場景**值得考慮補充。

### 2.2 架構圖表

**業界做法：**

| 工具 | 圖表方式 | 版本控制友善 | Agent 可解析 |
|------|---------|-------------|-------------|
| C4 + Structurizr | DSL → 自動生成 | ✅（code-based） | ✅（DSL 可解析） |
| arc42 | PlantUML / Mermaid | ✅（text-based） | ✅ |
| Google Design Doc | 手繪 / Draw.io | ❌（嵌入文件） | ❌ |
| IEEE 1016 | 不限 | 取決於工具 | 取決於工具 |

**你的框架：**

- ✅ DDD Level 1 使用 Mermaid 圖表——text-based、版本控制友善、Agent 可解析
- ✅ Context Map 的 Mermaid + 表格並用策略很好——圖表看拓撲、表格看細節
- ⚠️ SDD 模板本身沒有強制要求圖表——「系統架構」段落只寫了「架構圖或文字描述」
- ⚠️ 沒有類似 C4 的分層抽象指引（Context → Container → Component → Code）

**結論：** Mermaid 是正確的選擇（Agent 友善），但可以更積極地在 SDD 模板中推廣。業界趨勢是 Diagram as Code（用 Mermaid/PlantUML/Structurizr DSL 取代視覺化工具），你的框架已經在 DDD 中這樣做了，建議延伸到 SDD 的系統架構段落。

### 2.3 架構決策記錄（ADR）

**業界做法：**

- **Michael Nygard 格式（2011）**：Context / Decision / Consequences
- **MADR（Markdown Any Decision Records）**：更結構化，含 Options / Pros-Cons
- **adr-tools / log4brains**：CLI 管理工具，版本控制友善
- **2024-2025 趨勢**：AWS、Azure 官方推薦 ADR；log4brains 可自動生成靜態網站

**你的框架：**

- ✅ ADR 明確列為可選擴充，建議「做了有爭議的決策時當下順手記」
- ✅ 可併入 SDD 或獨立——彈性夠
- ✅ SDD 模板中有「技術決策」段落（決策/原因/替代方案/日期）
- ⚠️ 格式比 MADR 簡化——缺少「Status」欄位（Proposed/Accepted/Deprecated/Superseded）
- ⚠️ 沒有 ADR 之間的引用機制——業界用「Supersedes ADR-003」追蹤決策演進

**結論：** 你的 ADR 處理方式對 Agent 來說足夠（Agent 不需要完整的 ADR 生命週期管理），但如果要支援長期專案的決策追蹤，加入 Status 和 Supersedes 機制會更完善。

### 2.4 增量更新與文件演進

**業界做法：**

| 方法 | 做法 | 優點 | 缺點 |
|------|------|------|------|
| 整份修訂 | 新版本號覆蓋舊版 | 簡單 | 看不出改了什麼 |
| ADR 累積 | 每個決策一份 ADR | 決策歷史清楚 | 全貌分散在多份文件 |
| Changelog 段落 | 文件尾加 Changelog | 變更可追溯 | 容易忘記更新 |
| Living Documentation | 從 code/spec 自動生成 | 永遠最新 | 需要工具鏈支持 |
| **Delta Spec（OpenSpec 原創）** | ADDED/MODIFIED/REMOVED | 變更範圍精確 | 合併機制需要定義 |

**你的框架：**

- ✅ **Delta Spec 是你框架的核心創新之一**——在業界 SDD 實踐中，沒有其他標準提供等效的增量更新結構
- ✅ 完整的 Delta Spec 生命週期（產出 → 審閱 → 合併 → 歸檔）
- ✅ Change Folder 隔離（`changes/US-XXX/`）支援多 Agent 並行
- ✅ Changelog 段落也有保留，提供版本層級的變更概覽
- ⚠️ Delta Spec 的合併機制依賴 Agent 手動執行——業界 Living Documentation 趨勢是自動同步

**結論：** Delta Spec + Change Folder 是你框架在 SDD 更新機制上的**顯著優勢**。傳統標準的整份修訂方式對 Agent 來說太浪費 token；ADR 累積方式只追蹤決策不追蹤結構變更。Delta Spec 填補了這兩者之間的空白。

### 2.5 品質屬性與 NFR 的整合

**業界做法：**

- **arc42 Section 10**：Quality Scenarios（品質場景，類似 BDD 但針對 NFR）
- **Architectural Fitness Functions（Neal Ford）**：把品質屬性寫成可執行的自動化檢查
- **ISO 25010**：品質模型標準（功能適合性、效能效率、相容性、可用性、可靠性、安全性、可維護性、可移植性）
- **2024-2025 趨勢**：ArchUnit / NetArchTest 等工具讓架構約束可自動驗證

**你的框架：**

- ✅ **NFR ID 系統是業界獨創**——BDD `@perf(PERF-01)` 直接引用 NFR 閾值，傳統標準沒有對應物
- ✅ Constitution（專案憲法）類似 Architectural Fitness Functions，但以文件而非程式碼形式存在
- ✅ NFR 表格含具體指標、閾值、範圍、工具——比 arc42 的品質場景更可執行
- ⚠️ Constitution 目前是文件約束（Agent 遵守），尚未與自動化驗證工具（ArchUnit 等）連結
- ⚠️ 未涵蓋 ISO 25010 的部分品質面向（可移植性、可維護性、相容性）

**結論：** NFR ID 系統 + Constitution 的組合在業界是獨特的。傳統標準把 NFR 當作描述性文字，你的框架把 NFR 當作 Agent 可查詢的結構化資料。建議長期考慮 Constitution → 自動化 Fitness Function 的演進路徑。

---

## 三、與主流架構方法論的比較

### 3.1 arc42（最完整的模板框架）

arc42 的 12 個 section vs. 你框架的對應：

| arc42 Section | 內容 | 你的框架對應 | 覆蓋度 |
|---------------|------|-------------|--------|
| 1. Introduction & Goals | 需求概覽、品質目標 | 專案摘要（Why/Who/What） | ✅ 部分覆蓋（缺品質目標） |
| 2. Constraints | 技術/組織/慣例約束 | Constitution + 開發慣例 | ✅ 覆蓋 |
| 3. Context & Scope | 系統外部邊界 | DDD Level 1 Context Map | ✅ 覆蓋 |
| 4. Solution Strategy | 高層級技術決策 | ADR + SDD 技術決策 | ✅ 覆蓋 |
| 5. Building Block View | 模組結構（多層） | SDD 模組劃分 | ✅ 覆蓋（但只一層） |
| 6. Runtime View | 執行時序互動 | 缺少 | ❌ |
| 7. Deployment View | 部署拓撲 | 缺少（Lifecycle 只定義信任邊界） | ⚠️ 薄弱 |
| 8. Cross-cutting Concepts | 橫切關注點 | 部分散落在各處 | ⚠️ 未集中 |
| 9. ADR | 架構決策 | ADR（可選擴充） | ✅ 覆蓋 |
| 10. Quality Scenarios | 品質場景 | NFR 模板 + BDD @perf 標記 | ✅ 超越（NFR ID 系統） |
| 11. Risks & Technical Debt | 風險與技術債 | Memory ISSUES + [NEEDS CLARIFICATION] | ⚠️ 部分覆蓋 |
| 12. Glossary | 術語表 | DDD Level 2 Ubiquitous Language | ✅ 覆蓋（DDD 啟用時） |

**重點差距：**

- **Runtime View（執行時序）**：arc42 要求描述關鍵場景的執行流程（sequence diagram / activity diagram）。你的框架透過 BDD 場景描述行為，但缺少**模組間互動的時序圖**。這對 Agent 理解「模組 A 呼叫模組 B 的順序」很重要。
- **Deployment View（部署視圖）**：你的框架刻意把部署留給「專案層級的 CI/CD 配置」，這在 Lifecycle 中有說明。但 Agent 有時需要知道「這個服務跑在哪裡」才能做出正確的設計決策（如 latency 限制、資料分區）。
- **Cross-cutting Concepts（橫切關注點）**：日誌、錯誤處理、國際化、快取策略等。這些目前散落在 SDD 各模組中或 Constitution 中，沒有集中的位置。

### 3.2 C4 Model（視覺化架構描述）

**C4 的四層抽象 vs. 你的框架：**

| C4 層級 | 描述 | 你的框架對應 |
|---------|------|-------------|
| Level 1: System Context | 系統在環境中的位置 | DDD Context Map（部分） |
| Level 2: Container | 主要技術組件（前端、後端、DB） | SDD 系統架構 + 技術棧 |
| Level 3: Component | 模組內部結構 | SDD 模組劃分 |
| Level 4: Code | 類別/函式層級 | BDD → TDD 直接驅動實作 |

**比較：**

- ✅ 你的框架 Level 2-4 覆蓋良好——SDD 模組劃分對應 Container/Component，BDD→TDD 對應 Code
- ✅ C4 Level 4（Code）在你的框架中被 BDD + Test Scaffolding 取代——Agent 不需要類別圖，它直接從 BDD 產出程式碼
- ⚠️ Level 1（System Context）是最薄弱的——「系統和外部世界的關係」沒有專門的描述位置
- 💡 **Structurizr DSL** 的 Diagram as Code 方式值得參考——用文字定義架構，工具自動渲染圖表。你的 Mermaid 策略已經走在這個方向上

**結論：** C4 的分層抽象思維可以為你的 SDD 模板提供更清楚的組織邏輯。建議在 SDD 撰寫原則中加入「由外而內」的描述順序（先 System Context → 再 Container → 再 Component）。

### 3.3 Google Design Doc（科技公司實踐）

**Google Design Doc 的核心精神：**

- 「Why」比「What」重要——解釋為什麼這個設計合理
- 「Non-Goals」和「Goals」一樣重要——明確說明「不做什麼」
- 「Alternatives Considered」是必填——讓 reviewer 知道你考慮過什麼
- 強調 **ownership**——每個設計有明確的負責人

**你的框架：**

- ✅ ADR 段落涵蓋了「替代方案」和「原因」
- ✅ Constitution 隱含了「Non-Goals」的概念——「不做什麼」的紅線
- ⚠️ 沒有明確的「Goals / Non-Goals」段落——SDD 只描述「怎麼做」，不描述「這個 Story 要達成什麼 / 不做什麼」
- ⚠️ 沒有 ownership 概念——在多 Agent 協作中，「這個模組由哪個 Agent 負責」可能很重要

**結論：** Google Design Doc 的「Non-Goals」概念值得吸收。在 BDD 或 SDD 增量更新中明確標註「本 Story 不處理什麼」，能防止 Agent 過度延伸 scope。

---

## 四、與新興 AI-Driven 框架的 SDD 比較

### 4.1 OpenSpec

**定位：** 輕量級、brownfield 優先、token 高效。

| 面向 | OpenSpec | 你的框架 |
|------|---------|----------|
| SDD 結構 | 每個 change 一份輕量 spec | 全域 SDD + Delta Spec 增量 |
| 變更隔離 | Change folder（`changes/xxx/`） | Delta Spec + 可選 Change folder |
| 設計深度 | 夠用就好，不追求完整 | 模組劃分 + 資料模型 + ADR |
| 圖表 | 不強制 | Mermaid（DDD 中） |
| NFR | 不涵蓋 | 完整 NFR ID 系統 |
| DDD 整合 | 無 | 三層漸進式（Context Map / Glossary / Aggregate Root） |

**結論：** OpenSpec 的 SDD 是「剛好夠用」的哲學，適合 brownfield 場景。你的框架在 SDD 完整度上遠超 OpenSpec，代價是初始設定成本更高。兩者可以互補——brownfield 小改動用 OpenSpec 的輕量 spec，新功能用你的完整 BDD→SDD→TDD 流程。

### 4.2 GitHub Spec Kit

**定位：** 企業級、嚴格 phase gate、Specification as executable。

| 面向 | Spec Kit | 你的框架 |
|------|---------|----------|
| SDD 對應物 | Plan（架構、技術棧、約束宣告） | SDD + API 契約 |
| 設計審核 | Phase gate（-1 Gate，不通過就回頭） | Review Checkpoint |
| 任務拆分 | Tasks（Agent 拆為小單位） | Story 微觀瀑布 |
| Constitution | 核心概念（不可變原則） | 可選擴充（v0.13 吸收） |
| 文件格式 | 嚴格 Markdown 模板 | 結構化 Markdown 模板 |
| 增量機制 | 有 | Delta Spec（更明確） |

**結論：** Spec Kit 的 Plan 階段和你的 SDD 高度對應。主要差異在你的框架多了 API 契約層（OpenAPI/AsyncAPI）作為獨立的機器可讀文件，而 Spec Kit 把 API 設計嵌在 Plan 文件中。你的分離策略更好——API 契約可以直接被 code generator 和 mock server 消費。

### 4.3 BMAD METHOD

**定位：** 21 個專業 Agent、50+ 工作流、企業級。

| 面向 | BMAD | 你的框架 |
|------|------|----------|
| SDD 對應物 | Architecture Document（由 Architect Agent 產出） | SDD（由 Agent 在微觀瀑布中增量更新） |
| 角色分工 | 專業 Agent（PM Agent、Architect Agent、QA Agent、Coder Agent） | 不限定——可由單一 Agent 或多 Agent 執行 |
| 文件數量 | PRD + Architecture + User Stories + Tasks | Summary + BDD + SDD + 契約 + Memory |
| Context Engineering | 核心理念——設計最佳指令給 AI | Token 友善——壓縮 token 成本 |

**結論：** BMAD 和你的框架在 SDD 層的設計理念相似（結構化、增量、Agent 可消費），但 BMAD 更強調角色分工。你的框架把「角色分工」列為獨立議題（Agent Teams），這是更靈活的選擇——不是所有專案都需要 21 個 Agent。

### 4.4 你的框架在 SDD 層的獨特價值

在所有比較的標準和框架中，以下設計是你框架的獨特貢獻：

1. **Delta Spec 增量更新格式**：比 OpenSpec 的 change folder 更結構化（ADDED/MODIFIED/REMOVED），比傳統標準的整份修訂更省 token，比 ADR 更完整（追蹤結構變更，不只決策）。

2. **BDD → SDD → API 契約的三層連動**：業界把 BDD、SDD、API spec 當作獨立的實踐。你的框架定義了明確的推導鏈——BDD 場景決定需要哪些模組（SDD），模組的對外介面定義在契約中。這讓 Agent 不需要猜測「BDD 場景對應到哪個模組」。

3. **Constitution + NFR ID 的雙重護欄**：Constitution 是定性的紅線（SHALL 等級），NFR ID 是定量的閾值。兩者互補，覆蓋了「設計原則」和「品質指標」兩個維度。

4. **Verify 三重檢查（Completeness/Correctness/Coherence）**：這不是測試層面的驗證（那是 TDD 的事），而是**文件層面的一致性驗證**。業界沒有等效的自動化機制——最接近的是 arc42 的 Review Checklist，但那是人類手動執行的。

5. **DDD 漸進式分裂 + SDD 嵌入策略**：業界的 DDD 和 SDD 通常是獨立的。你的框架允許小型專案把 DDD 嵌入 SDD，大型專案才獨立——這種漸進式策略在其他框架中沒有看到。

---

## 五、SDD 撰寫細節比較

### 5.1 模組描述粒度

**業界做法：**

- arc42 要求三層（Context → Building Block → Component Detail）
- C4 也是三層（Container → Component → Code）
- Google Design Doc 不限粒度，依需求決定

**你的框架：**

```markdown
### <模組名稱>
- **職責**: <這個模組負責什麼>
- **對外介面**: <提供什麼 API 或函式>
- **依賴**: <依賴哪些其他模組>
- **資料模型**: <核心資料結構>
```

- ✅ 四個面向（職責/介面/依賴/資料模型）覆蓋了 Agent 做出實作決策所需的最小資訊
- ⚠️ 缺少「內部子模組」的遞迴結構——當模組很大時，Agent 需要知道內部的分工
- ⚠️ 缺少「錯誤處理策略」——每個模組遇到異常時怎麼處理（重試? 降級? 傳遞?）

**結論：** 四個面向作為最小模組描述是好的。建議加入可選的「錯誤處理」和「內部結構」欄位，用 `[如需]` 標記讓 Agent 知道只有複雜模組才需要填。

### 5.2 資料模型描述

**業界做法：**

| 方法 | 工具 | 特色 |
|------|------|------|
| ER Diagram | Mermaid / dbdiagram.io | 視覺化關聯 |
| Schema DSL | Prisma / Drizzle / SQLAlchemy | 可執行的 schema 定義 |
| OpenAPI schemas | YAML/JSON | 與 API 契約整合 |
| DDD Entity/Value Object | 文字描述 | 強調業務語義 |

**你的框架：**

- ✅ SDD 模板有「資料模型」段落
- ✅ DDD Level 3 的 Aggregate Root 嵌入 SDD，強調業務約束
- ✅ OpenAPI/AsyncAPI schemas 提供機器可讀的資料結構
- ⚠️ 沒有明確建議用 Mermaid ER diagram 或其他視覺化方式
- ⚠️ SDD 資料模型和 API 契約中的 schemas 可能重複——沒有明確的「誰是 source of truth」

**結論：** 建議在 SDD 撰寫原則中明確「資料模型的 source of truth 是 SDD，API 契約的 schemas 從 SDD 推導」。考慮加入 Mermaid ER Diagram 範例。

### 5.3 跨模組互動描述

**業界做法：**

- **arc42 Section 6 (Runtime View)**：用 sequence diagram 描述關鍵場景的模組互動
- **C4 Dynamic Diagram**：展示特定使用者行為的元件互動
- **AsyncAPI**：描述事件驅動的模組互動

**你的框架：**

- ✅ SDD 有「跨模組互動」段落（同步 API call、事件驅動、shared DB）
- ✅ AsyncAPI 涵蓋了事件驅動互動的結構化描述
- ✅ DDD Context Map 的「互動模式」表格（上游/下游/關係類型/介面/模式）
- ⚠️ 缺少 sequence diagram——對於複雜的多步驟互動（如「結帳流程涉及 Sales→Billing→Shipping」），文字描述不夠清楚

**結論：** 跨模組互動是 Agent 實作時最容易出錯的地方。建議在複雜互動場景中使用 Mermaid sequence diagram 輔助描述。

---

## 六、具體建議

### 高優先級（補強 SDD 核心描述能力）

1. **補充 System Context 描述**：在 SDD 模板的「系統架構」段落加入「系統與外部系統的關係」（對應 C4 Level 1 / arc42 Section 3），讓 Agent 知道系統邊界在哪。建議用 Mermaid graph 視覺化。

2. **加入 Mermaid 圖表指引**：SDD 撰寫原則中明確建議「系統架構用 Mermaid graph、資料模型用 Mermaid erDiagram、複雜互動用 Mermaid sequenceDiagram」。你已經在 DDD 中這樣做了，延伸到 SDD 即可。

3. **補充宣告式風格指引（同 BDD 比較建議）**：在 BDD 撰寫原則中加入「優先使用宣告式 Given/When/Then，避免描述 UI 操作細節」。

4. **明確資料模型 Source of Truth**：SDD 撰寫原則中加入「資料模型定義在 SDD 中，API 契約 schemas 和 DDD Glossary 從 SDD 推導，SDD 是唯一 source of truth」。

### 中優先級（擴充框架能力）

5. **加入 Non-Goals 概念**：在 BDD 或 SDD Delta Spec 中加入可選的「Non-Goals / Out of Scope」段落，防止 Agent 過度延伸 Story 範圍。Google Design Doc 把這列為必填。

6. **模組錯誤處理策略**：在 SDD 模組描述中加入可選的「Error Handling」欄位（重試策略、降級行為、錯誤傳遞方式）。

7. **ADR Status 機制**：在 ADR 格式中加入 Status 欄位（Proposed/Accepted/Deprecated/Superseded），支援決策演進追蹤。

8. **Scenario Outline 範例（同 BDD 比較建議）**：BDD 模板中補充參數化場景的寫法（`Scenario Outline:` + `Examples:` table），讓 Agent 知道何時用 data table。

### 低優先級（長期演進）

9. **Runtime View（執行時序圖）**：對於關鍵場景（如結帳、認證流程），在 SDD 中加入 Mermaid sequence diagram 描述模組間的時序互動。

10. **Constitution → Fitness Function 演進路徑**：長期考慮把 Constitution 的部分原則轉化為可自動驗證的 Fitness Functions（如 ArchUnit 規則），從「Agent 遵守文件」進化到「CI 自動驗證」。

11. **Deployment View（部署視圖）**：當專案需要 Agent 理解部署拓撲（如微服務間的網路邊界）時，加入輕量級的部署視圖模板。

12. **Cross-cutting Concerns 段落**：SDD 中加入一個集中段落描述橫切關注點（日誌策略、錯誤處理慣例、國際化、快取策略），避免同一規則散落在每個模組描述中重複。

---

## 七、總結

你的 Agentic Coding Framework 在 SDD 層面做了一個清楚的定位選擇：**不追求傳統 SDD 的「完整架構描述」，而追求 Agent 驅動開發的「最小可行架構文件」**。

這個選擇帶來了三個優勢和兩個代價：

**優勢：**

1. **Token 效率**：分層載入 + Delta Spec 增量更新，Agent 不需要每次讀完整份 arc42 文件
2. **驅動性**：SDD 不是寫完放著的文件，而是 Agent 工作流中的活節點——BDD 推導出 SDD 變更，SDD 驅動 API 契約，契約驅動 TDD
3. **一致性保證**：Verify 三重檢查（特別是 Coherence 維度）確保 SDD 不會和實作脫鉤

**代價：**

1. **架構描述不如 arc42 完整**：缺少 Runtime View、Deployment View、Cross-cutting Concepts 的集中描述。對於複雜系統，Agent 可能缺少做出正確設計決策的上下文
2. **不適合非 Agent 消費者**：傳統架構師、PM、利害關係人可能覺得你的 SDD 模板「太簡潔」。如果有這類需求，考慮在 SDD 旁邊生成一份 arc42 風格的完整文件

與傳統 SDD 標準的最大差異在於**更新機制**：IEEE 1016 和 arc42 假設文件會被定期整份修訂；你的框架假設文件會被每個 Story 增量更新。Delta Spec 是這個假設的具體實現，也是你框架在 SDD 領域最大的創新。

需要加強的部分集中在**視覺化描述**（Mermaid 圖表應從 DDD 延伸到 SDD）和**系統邊界定義**（C4 Level 1 的 System Context）——這些是成熟架構描述方法論的核心能力，Agent 在處理複雜系統互動時會需要它們。
