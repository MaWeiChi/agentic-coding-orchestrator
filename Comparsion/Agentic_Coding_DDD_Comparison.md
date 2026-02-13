# Agentic Coding Framework × DDD 最佳實踐比較分析

**你的框架 vs. Eric Evans / Vaughn Vernon 經典 DDD、Event Storming、Context Mapper、jMolecules / ArchUnit、以及 AI-Driven DDD 新興實踐**

February 2026

---

## 一、定位差異：框架在 DDD 光譜上的位置

經典 DDD（Eric Evans 2003、Vaughn Vernon 2013）的定位是 **「以業務領域為中心的軟體設計方法論」**——它解決的是「怎麼讓軟體結構映射業務現實，而非反過來」。

你的 Agentic Coding Framework 將 DDD 定位為 **可選擴充**（v0.9 加入），觸發條件是「專案涉及多個業務領域、同一名詞在不同模組代表不同概念」。框架採用輕量級三層漸進策略（Bounded Context → Ubiquitous Language → Aggregate Root），定位在「解決 Agent 的上下文溢出問題」而非「完整的領域建模方法論」。

這意味著經典 DDD 是一套涵蓋戰略設計到戰術實作的完整哲學體系，你的框架從中萃取了對 AI Agent 最有價值的子集——Context 隔離與命名約束。

| 面向 | 經典 DDD | Agentic Coding Framework |
|------|---------|--------------------------|
| 核心使命 | 業務複雜性管理 | Agent 上下文工程（Context Engineering） |
| 消費者 | 人類領域專家 + 架構師 + 開發者 | AI Agent + 人類團隊 |
| 涵蓋範圍 | 戰略設計 + 戰術設計 + 組織結構 | 戰略設計（L1-L2）+ 輕量戰術（L3） |
| 驅動方式 | 業務需求驅動 | Token 效率 + Context Window 限制驅動 |
| 觸發時機 | 專案啟動即開始 | 條件觸發（多業務領域時才啟用） |

---

## 二、戰略設計：逐項比較

### 2.1 Bounded Context

**業界做法：**

Bounded Context 是 DDD 的核心戰略概念。一個 Bounded Context 定義了一個明確的邊界，在此邊界內，領域模型具有唯一且一致的含義。業界實踐包含：

- Context 的發現透過 Event Storming 等工作坊進行，由領域專家與技術團隊協作完成
- 每個 Context 有獨立的程式碼庫、資料庫 schema、部署單元（微服務場景）
- Context 之間的整合模式有標準分類：Shared Kernel、Customer-Supplier、Conformist、Anti-Corruption Layer（ACL）、Open Host Service / Published Language、Partnership
- 工具支援：Context Mapper DSL 可將 Context Map 程式碼化，版本控制友善

**你的框架（Level 1）：**

- ✅ Bounded Context Map 含 Mermaid 視覺化 + 表格定義——Agent 可解析、人類可閱讀
- ✅ 互動模式表格（上游/下游/關係類型/介面/模式）涵蓋了 Customer-Supplier、ACL、OHS 等核心模式
- ✅ 每個 Context 對應獨立的路徑和 API 契約——與微服務對齊
- ✅ 漸進式分裂策略（小專案併入 SDD、大專案獨立目錄）——這在業界 DDD 實踐中少見，是框架的獨特設計
- ⚠️ Context 的 **發現流程** 未定義——業界用 Event Storming 做探索，你的框架假設 Context 邊界已由人類決定
- ⚠️ 缺少 **Shared Kernel** 和 **Conformist** 模式的處理指引——互動模式表格只列了 Customer-Supplier 和 OHS
- ⚠️ 缺少 **Context 演進策略**——何時分裂一個 Context、何時合併兩個 Context

**結論：** 你的框架在 Bounded Context 的 **文件化描述** 上做得很好（Mermaid + 表格的組合對 Agent 極其友善），但在 Context 的 **發現** 和 **演進** 上是空白。這是合理的——你的框架解決的是「Agent 怎麼讀懂 Context 邊界」，不是「怎麼找到 Context 邊界」。

### 2.2 Context Mapping Patterns

**業界標準模式（共 9 種）：**

| 模式 | 定義 | 適用場景 |
|------|------|---------|
| Shared Kernel | 兩個 Context 共享一小部分模型 | 緊密合作的團隊 |
| Customer-Supplier | 上游提供服務，下游消費 | 有明確上下游關係 |
| Conformist | 下游完全採用上游模型 | 下游無談判籌碼 |
| Anti-Corruption Layer (ACL) | 下游翻譯上游模型為自己的語言 | 防止外部模型汙染內部 |
| Open Host Service (OHS) | 上游提供標準化 API | 多個下游消費者 |
| Published Language | 標準化的交換格式 | 跨組織整合 |
| Partnership | 對等合作 | 雙方共同演進 |
| Separate Ways | 完全獨立 | 整合成本高於價值 |
| Big Ball of Mud | 識別並隔離混亂區域 | 既有遺留系統 |

**你的框架：**

- ✅ DDD 格式指南的互動模式表格包含 Customer-Supplier、ACL、OHS——覆蓋了最常見的三種
- ⚠️ 缺少 Shared Kernel、Conformist、Partnership、Separate Ways——在多團隊或遺留系統場景中會用到
- ⚠️ 沒有 Big Ball of Mud 的識別指引——對既有專案的反向工程特別重要

**結論：** 目前覆蓋的三種模式足以應對單團隊的 Agentic Coding 場景。如果框架要支援企業級多團隊開發，建議在 DDD 格式指南中至少補充 Shared Kernel 和 Conformist。

### 2.3 Ubiquitous Language

**業界做法：**

Ubiquitous Language 是 DDD 的基石。業界最佳實踐包含：

- 語言由領域專家與開發者在 **對話中共同建立**，不是技術團隊單方面定義
- 語言的變化是 Context 邊界變化的信號——當同一個詞在不同場景代表不同含義，就需要分 Context
- 語言應出現在所有層面：UI 文案、資料庫欄位、API 參數、程式碼變數名、文件
- 工具：Context Mapper DSL 的 Domain Model 可以程式碼化 Ubiquitous Language

**你的框架（Level 2）：**

- ✅ Glossary 表格含「術語 / Context A 定義 / Context B 定義 / 類型約束 / 範例值」——**類型約束欄位是你框架的獨創**，業界 Glossary 通常不包含資料型別
- ✅ 明確的強制指令：「所有 Agent 在命名變數、資料庫欄位、API 參數時，必須嚴格遵守此表。禁止使用同義詞。」——這是為 Agent 量身設計的，人類用自律約束，Agent 用明確指令
- ✅ 跨 Context 的同一術語差異對照——直接解決「Sales 的 User 叫 Customer，Shipping 的 User 叫 Recipient」
- ⚠️ 語言的 **發現流程** 未定義——業界用 Event Storming 和持續對話建立語言
- ⚠️ 缺少 **語言演進規則**——新增或修改術語時的流程（誰有權改? 改了後哪些 Agent 需要重新載入?）

**結論：** 你的 Glossary 設計在 Agent 消費性上超越業界標準——類型約束讓 Agent 不需猜測資料型別，強制指令讓 Agent 不會自作主張發明同義詞。這是將 Ubiquitous Language 從「團隊共識」轉化為「Agent 可執行指令」的成功設計。

### 2.4 Subdomain Classification

**業界做法：**

DDD 將業務領域分為三種 Subdomain：

| 類型 | 定義 | 投資策略 |
|------|------|---------|
| Core Domain | 業務核心競爭力 | 最大投資，最好的團隊 |
| Supporting Subdomain | 必要但非差異化 | 適當投資 |
| Generic Subdomain | 通用功能（認證、日誌等） | 買現成的或用開源 |

**你的框架：**

- ⚠️ **未涵蓋 Subdomain 分類**。Context Map 表格有「備註」欄位可填「核心業務」，但沒有系統性的分類指引

**結論：** Subdomain 分類在 Agentic Coding 中有實用價值——Agent 對 Core Domain 應投入更多測試覆蓋和設計審查，對 Generic Subdomain 可以更大膽地使用現成方案。建議在 Context Map 表格中加入「類型（Core/Supporting/Generic）」欄位。

---

## 三、戰術設計：逐項比較

### 3.1 Aggregate Root

**業界做法：**

Aggregate 是 DDD 戰術設計的核心，由 Eric Evans 和 Vaughn Vernon 建立的最佳實踐包含：

- **小而聚焦**：Aggregate 應盡可能小，只包含必須保持一致性的實體
- **一致性邊界**：Aggregate 內部保證即時一致性（strong consistency），Aggregate 之間只保證最終一致性（eventual consistency）
- **Aggregate Root 是唯一入口**：外部只能透過 Aggregate Root 操作 Aggregate 內的實體
- **Invariant 規則**：Aggregate 負責維護不變條件（如「訂單總金額 = 明細總和」）
- **一個 Repository 對應一個 Aggregate Root**：不為子實體建立獨立 Repository

**你的框架（Level 3）：**

- ✅ Aggregate Root 嵌入 SDD 的模組段落，用 `[DDD 戰術約束]` 標記區塊
- ✅ 明確定義 Invariant 規則和存取限制
- ✅ 「只能透過 Order 存取，禁止單獨 Repository 查詢」的約束
- ✅ Methods 列出業務操作和觸發的 Domain Event
- ⚠️ 缺少 **Aggregate 大小設計指引**——業界強調「小 Aggregate」原則，但框架未提及
- ⚠️ 缺少 **跨 Aggregate 一致性策略**——業界用 Domain Event 達成最終一致性
- ⚠️ 缺少 **Entity vs. Value Object 的區分指引**——業界有明確的判斷標準（有無 identity、可否替換）

**結論：** 你的框架在 Aggregate Root 的描述格式上精準到位——`[DDD 戰術約束]` 標記讓 Agent 一眼識別約束區塊，Invariant 規則讓 Agent 知道什麼不能違反。但 Aggregate 的 **設計指引**（多大算合適? 什麼時候該拆? Entity 和 Value Object 怎麼分?）是空白的——這些在你的「條件觸發」定位下是合理的省略，但進入 Level 3 的專案通常需要這些指引。

### 3.2 Domain Event

**業界做法：**

Domain Event 是 DDD 戰術設計中越來越重要的模式（2015 年後成為主流）：

- 代表業務上「發生了什麼事」（如 OrderPlaced、PaymentConfirmed）
- 不可變（Immutable）——一旦發生就不能修改
- 觸發跨 Aggregate 或跨 Context 的後續動作
- 是 Event Sourcing 的基礎
- 與 BDD 場景自然對應：Given（前置事件）→ When（命令）→ Then（產出事件）

**你的框架：**

- ✅ Context Map 的互動模式中使用 Domain Event（如 `OrderPlaced Event`、`PaymentAuthorized Event`）
- ✅ Aggregate Root 的 Methods 定義中標示觸發的事件（`confirm()`: 觸發 `OrderPlaced` 事件）
- ✅ AsyncAPI 契約可描述事件驅動介面
- ⚠️ **Domain Event 沒有獨立的定義格式**——Event 的 payload、觸發條件、消費者散落在 Context Map、SDD、AsyncAPI 三處
- ⚠️ **Event 與 BDD 場景的映射關係未明確**——業界的 Event Mapping 可以將 Event Storming 結果直接轉化為 BDD 的 Given/When/Then

**結論：** Domain Event 在你的框架中「存在但未被正式化」。考慮到 Event 是跨 Context 溝通的核心機制，建議在 DDD 格式指南中加入 Domain Event Registry（事件清單），作為 AsyncAPI 的上層摘要。

### 3.3 Repository Pattern

**業界做法：**

- Repository 是 Aggregate Root 的持久化介面
- Domain 層只定義 Repository 介面，Infrastructure 層實作
- 常與 Hexagonal Architecture / Clean Architecture 搭配

**你的框架：**

- ⚠️ SDD 模組描述中有「對外介面」和「依賴」，但 **沒有明確的 Repository 概念**
- ⚠️ 缺少 Domain 層與 Infrastructure 層的分離指引

**結論：** Repository Pattern 屬於實作層級的指引，與你框架的「Level 3 可選」定位一致。如果使用 Level 3，建議在 SDD 撰寫原則中加入「每個 Aggregate Root 對應一個 Repository 介面」的慣例。

### 3.4 Domain Service vs. Application Service

**業界做法：**

| 類型 | 職責 | 狀態 | 範例 |
|------|------|------|------|
| Domain Service | 跨 Entity 的業務邏輯 | Stateless | 信用審核服務 |
| Application Service | 協調 Domain 與外部世界 | Stateless | 結帳流程編排 |

**你的框架：**

- ⚠️ 未區分 Domain Service 和 Application Service——SDD 模組劃分中用「職責」描述，但沒有分類指引

**結論：** 在 Agentic Coding 的脈絡下，Application Service 的概念特別有意義——它可以映射為 Agent 的工作流（微觀瀑布中的一輪迭代），而 Domain Service 映射為業務邏輯封裝。但這屬於進階指引，可列入待探討事項。

---

## 四、DDD 發現流程：Event Storming 比較

### 4.1 Event Storming 概述

Event Storming 是 Alberto Brandolini 於 2013 年提出的協作式工作坊方法，用便利貼在時間軸上排列 Domain Event，從而發現業務流程、Context 邊界和 Aggregate。

**核心元素：**

| 便利貼顏色 | 代表 | 範例 |
|-----------|------|------|
| 橘色 | Domain Event | 「訂單已建立」 |
| 藍色 | Command | 「建立訂單」 |
| 黃色 | Actor / User | 「買家」 |
| 粉紅色 | External System | 「金流服務」 |
| 紫色 | Policy | 「訂單建立後自動通知倉庫」 |
| 淺黃 | Aggregate | 「訂單」 |

**主流工具（2025-2026）：**

| 工具 | 類型 | 特色 |
|------|------|------|
| Miro | 線上白板 | 官方 Event Storming 模板、AI 輔助分析 |
| FigJam | 線上白板 | Figma 生態整合 |
| EventCatalog | 文件工具 | Markdown 驅動的事件目錄，Living Documentation |
| Context Mapper | DSL 工具 | 將 Event Storming 結果程式碼化 |
| Domain Storytelling | 建模工具 | 用圖示化故事描述業務流程 |
| Qlerify | AI 工具 | AI 輔助 DDD 建模 |

### 4.2 Event Storming × BDD 的連結

**業界發現（Cucumber 社群的 Event Mapping）：**

Event Storming 的 Event → Command → Event 序列可以直接映射為 BDD 的 Given → When → Then：

```
Event Storming:         BDD:
前置事件 ──────────→  Given（前置條件）
命令（Command）────→  When（使用者操作）
產出事件 ──────────→  Then（預期結果）
```

這意味著 Event Storming 不只是發現 Context 邊界的工具，也是 BDD 場景的結構化產出來源。

### 4.3 你的框架與 Event Storming 的關係

**現況：**

- ⚠️ 框架 **完全未提及 Event Storming**——BDD 場景假設由人類撰寫，Context 邊界假設由人類決定
- ⚠️ 缺少從「業務需求」到「BDD 場景」的結構化轉換流程

**評估：**

你的框架定位是「Agent 的工作基礎建設」，Event Storming 是「人類的需求發現流程」——兩者處理的階段不同。但它們之間存在一個有價值的連結點：

| 階段 | 工具/方法 | 產出 | 框架對應 |
|------|----------|------|---------|
| 需求發現 | Event Storming | Domain Event 清單、Context 邊界、Aggregate 候選 | **空白** |
| 行為定義 | BDD 場景撰寫 | Given/When/Then 場景 | 第二層 BDD |
| 架構設計 | SDD | 模組劃分、資料模型 | 第三層 SDD |

**結論：** Event Storming 的產出可以成為 Bootstrap 階段的輸入——Event 清單轉化為 Context Map，Command 轉化為 BDD 的 When，Event 轉化為 BDD 的 Then。建議在框架的 Bootstrap 流程中加入「如果專案已做過 Event Storming，如何將結果對接到框架」的指引。

---

## 五、DDD 工具鏈比較

### 5.1 Context Mapper vs. 你的框架

**Context Mapper：**

- 開源 DSL 工具，將 Context Map 程式碼化
- 支援自動生成 PlantUML / Mermaid 圖表
- 可搭配 ArchUnit 做架構驗證
- 定義嚴格的語法，機器可解析

**你的框架：**

- 用 Markdown（Mermaid + 表格）描述 Context Map
- 無需額外工具，Agent 直接讀取
- 更輕量，但缺少自動驗證能力

| 維度 | Context Mapper | 你的框架 |
|------|---------------|----------|
| 學習成本 | 中（需學 DSL 語法） | 低（Markdown + Mermaid） |
| 機器可解析 | ✅ 嚴格 DSL | ✅ Markdown 結構化 |
| 自動驗證 | ✅ 搭配 ArchUnit | ❌ |
| Agent 友善度 | ⚠️ 需要 Agent 理解 DSL | ✅ Agent 原生讀取 Markdown |
| 版本控制 | ✅ text-based | ✅ text-based |
| 視覺化 | ✅ 自動生成 | ✅ Mermaid 手動維護 |

**結論：** 你的框架選擇 Markdown + Mermaid 而非 Context Mapper DSL 是正確的——Agent 不需要學習額外的 DSL，直接讀取 Markdown 更省 token。但 Context Mapper 的自動驗證能力（搭配 ArchUnit）值得在 Constitution → Fitness Function 的演進路徑中參考。

### 5.2 jMolecules / ArchUnit vs. 你的 Constitution

**jMolecules（Java 生態）：**

- 用 annotation / interface 標記 DDD 概念（`@AggregateRoot`、`@ValueObject`、`@DomainEvent`）
- 搭配 ArchUnit 在 build 時自動驗證：「Value Object 不可有 setter」「只有 Aggregate Root 可被 Repository 管理」
- 編譯時即發現架構違規

**你的框架（Constitution）：**

- 用文件定義架構原則（SHALL 等級）
- Agent 在做設計決策前檢查 Constitution
- Verify 步驟的 Coherence 維度檢查 Constitution 是否被違反

| 維度 | jMolecules + ArchUnit | Constitution |
|------|----------------------|-------------|
| 驗證時機 | 編譯時 / CI 時（自動） | Agent 設計時 + Verify 時（半自動） |
| 驗證範圍 | 程式碼層級（class/method） | 架構層級（模組/API/資料流） |
| 語言限制 | Java / Kotlin | 語言無關 |
| 表達能力 | 具體（annotation level） | 抽象（原則 level） |
| 違規成本 | 低（編譯立即報錯） | 中（Verify 才發現） |

**結論：** 兩者互補而非替代。Constitution 處理的是 Agent 層級的設計約束（「禁止跨模組直接 DB 存取」），jMolecules/ArchUnit 處理的是程式碼層級的實作約束（「Value Object 不可變」）。長期演進方向：把 Constitution 中可程式化的原則轉化為 ArchUnit 規則，實現 CI 自動驗證。

### 5.3 EventCatalog vs. 你的 AsyncAPI + Context Map

**EventCatalog：**

- Markdown 驅動的事件目錄
- 自動生成 Living Documentation 網站
- 事件的 schema、owner、consumer 一目了然

**你的框架：**

- AsyncAPI 定義事件介面格式
- Context Map 的互動模式標注事件流向
- Domain Event 散落在 SDD 的 Aggregate Root 段落

**結論：** EventCatalog 的「事件目錄」概念可以啟發你的框架——在 DDD 格式指南中加入一份集中的 Domain Event Registry，讓 Agent 快速查閱所有跨 Context 的事件，而非分散在 AsyncAPI 和 SDD 各處。

---

## 六、DDD 在 Agentic Coding 中的獨特價值

### 6.1 Context Window 分區

2025-2026 年的實踐已經證實：**Bounded Context 是 LLM Context Window 分區的天然邊界。**

| 挑戰 | DDD 的解法 | 你框架的實作 |
|------|-----------|-------------|
| Agent 塞不下整個 codebase | 每個 Context 獨立，Agent 只載入當前 Context | ✅ Level 1 Bounded Context |
| 多 Agent 各自負責一個模組 | Context 是 Agent 的工作邊界 | ✅ 框架觸發條件之一 |
| 跨 Context 通訊容易出錯 | ACL + Published Language 隔離語義 | ✅ 互動模式表格 |

你的框架在 v0.9 中將「Context Window 塞不下整個 codebase」列為 DDD 的觸發條件——這是業界首次明確將 DDD 的戰略設計與 LLM 的技術限制掛鉤。

### 6.2 Ubiquitous Language 對 Agent 的效益

業界研究（2025-2026）發現 Ubiquitous Language 對 AI Agent 的效益比對人類更顯著：

- **人類**：Ubiquitous Language 減少溝通歧義，但人類可以靠上下文補償
- **Agent**：Ubiquitous Language 直接影響程式碼品質——Agent 命名變數時嚴格遵守 Glossary 產出的程式碼，比自行推斷的命名一致性高數倍

你的框架的「禁止使用同義詞」指令在 Agent 場景下特別有效——Agent 沒有「創意命名」的需求，強制約束不會損失任何價值，只會提升一致性。

### 6.3 DDD + Event Storming → BDD 的自動推導鏈

業界正在形成一條從發現到實作的完整鏈路：

```
Event Storming → Domain Events + Commands + Aggregates
     ↓
Context Map（戰略邊界）
     ↓
BDD Scenarios（Event Mapping: Event → Given/When/Then）
     ↓
Test Scaffolding → Implementation → Verify
```

你的框架目前覆蓋了 Context Map 以下的所有環節，但 Event Storming → Context Map 和 Event Storming → BDD 的轉換是空白。這是人類主導的階段，但框架可以定義「產出格式」來銜接。

---

## 七、與參考實作的比較

### 7.1 eShopOnContainers（.NET 參考架構）

| 特性 | eShopOnContainers | 你的框架 |
|------|-------------------|----------|
| Bounded Context | Catalog, Basket, Ordering, Identity | 由專案定義 |
| Context 間通訊 | Domain Events + Integration Events + Message Bus | AsyncAPI 定義 + Context Map 標注 |
| Aggregate | OrderAggregate, BuyerAggregate | SDD 嵌入 `[DDD 戰術約束]` |
| 測試策略 | Unit + Integration + Functional | BDD 標記驅動五層金字塔 |
| 文件 | Architecture docs + README | Summary → BDD → SDD → 契約 → Memory |

**結論：** eShopOnContainers 是完整的 DDD 戰術設計參考——你的框架可以把它當作 Level 3 的範例專案，特別是 Aggregate 設計和跨 Context 事件的部分。

### 7.2 Vaughn Vernon 的 IDDD Samples

Vaughn Vernon 的 IDDD（Implementing Domain-Driven Design）範例專案展示了完整的戰略+戰術設計。與你的框架比較：

- **IDDD 的強項**：完整的 Aggregate 設計、Domain Event、Repository Pattern、Application Service 分層
- **你的框架的強項**：Agent 可消費的文件格式、Delta Spec 增量更新、BDD 場景驅動測試、跨工具 Memory
- **交集**：Bounded Context 隔離、Ubiquitous Language 約束、Aggregate Root 不變條件

### 7.3 ddd-starter-modelling-process

這是一個輕量級的 DDD 建模流程框架，步驟為：

```
1. Align（對齊業務願景）
2. Discover（Event Storming 發現領域）
3. Decompose（拆分 Bounded Context）
4. Connect（定義 Context 整合策略）
5. Strategize（Core/Supporting/Generic 分類）
6. Organize（團隊拓撲）
7. Define（戰術設計）
8. Code（實作）
```

**與你的框架比較：**

| ddd-starter 步驟 | 你的框架對應 | 覆蓋度 |
|------------------|-------------|--------|
| 1. Align | 專案摘要（Why/Who/What） | ✅ |
| 2. Discover | **空白**（假設已完成） | ❌ |
| 3. Decompose | DDD Level 1 Context Map | ✅ |
| 4. Connect | 互動模式表格 | ✅ |
| 5. Strategize | 未涵蓋 Subdomain 分類 | ⚠️ |
| 6. Organize | Agent Teams（待定義） | ⚠️ |
| 7. Define | DDD Level 3 Aggregate Root | ✅ |
| 8. Code | TDD（Test Scaffolding → Implementation） | ✅ |

**結論：** ddd-starter-modelling-process 的步驟 2（Discover）和步驟 5（Strategize）是你的框架最需要補強的部分。

---

## 八、綜合建議

### 高優先級（補強 DDD 核心能力）

1. **Event Storming 產出對接指引**：在 Bootstrap 流程中加入「如果專案已做過 Event Storming，將 Event 清單轉化為 Context Map + BDD 場景的步驟」。不需要框架自己辦 Event Storming——那是人類的工作，但框架應定義如何消費 Event Storming 的產出。

2. **Domain Event Registry**：在 DDD 格式指南中加入集中的事件清單模板（Event Name / Source Context / Target Context / Payload Ref / AsyncAPI Ref），作為 AsyncAPI 的上層索引。目前事件資訊散落在 Context Map、SDD、AsyncAPI 三處，Agent 需要多次載入才能拼湊全貌。

3. **補充 Context Mapping 模式**：互動模式表格中至少加入 Shared Kernel 和 Conformist 的處理指引，覆蓋既有專案整合的常見場景。

### 中優先級（擴充設計指引）

4. **Subdomain 分類欄位**：Context Map 表格加入「類型（Core/Supporting/Generic）」，讓 Agent 對 Core Domain 投入更多測試和設計審查力度。

5. **Aggregate 設計原則**：Level 3 加入「小 Aggregate 原則」「跨 Aggregate 用 Domain Event 達成最終一致性」「Entity vs. Value Object 判斷標準」等設計指引。

6. **Event Mapping → BDD 轉換模板**：提供 Event Storming 結果到 BDD 場景的結構化轉換範例（Event → Given、Command → When、Event → Then），讓人類在 Bootstrap 時有明確的格式可循。

### 低優先級（長期演進）

7. **Constitution → ArchUnit 演進路徑**：定義如何將 Constitution 中可程式化的原則（如「禁止跨模組直接 DB 存取」）轉化為 ArchUnit 規則，在 CI 中自動驗證。

8. **Context 演進策略**：定義何時分裂/合併 Context 的啟發式規則（如「SDD 中某個模組的 Delta Spec 頻繁觸及多個 Context → 考慮重新劃定邊界」）。

9. **Domain Service vs. Application Service 分類指引**：在 SDD 撰寫原則中區分兩者，特別是在 Agentic Coding 脈絡下——Application Service 可映射為 Agent 工作流，Domain Service 映射為業務邏輯封裝。

---

## 九、附錄：各框架/工具特性對照表

| 特性 | 你的框架 | 經典 DDD | Event Storming | Context Mapper | jMolecules | eShopOnContainers |
|------|---------|---------|---------------|---------------|-----------|-------------------|
| Bounded Context 定義 | ✅ Mermaid + 表格 | ✅ 理論定義 | ✅ 發現工具 | ✅ DSL 程式碼化 | ⚠️ Annotation 標記 | ✅ 完整實作 |
| Context 發現流程 | ❌ 未定義 | ⚠️ 對話驅動 | ✅ 核心能力 | ⚠️ 記錄非發現 | N/A | N/A |
| Ubiquitous Language | ✅ Glossary + 強制指令 | ✅ 理論定義 | ⚠️ 隱含 | ✅ Domain Model | ⚠️ Annotation | ⚠️ 程式碼命名 |
| Aggregate Root 約束 | ✅ SDD 嵌入 | ✅ 理論定義 | ⚠️ 發現階段 | ✅ DSL 定義 | ✅ 編譯時驗證 | ✅ 完整實作 |
| Domain Event | ⚠️ 散落多處 | ✅ 理論定義 | ✅ 核心概念 | ✅ DSL 定義 | ✅ Annotation | ✅ 完整實作 |
| 自動化驗證 | ⚠️ Verify（半自動） | ❌ | N/A | ✅ 搭配 ArchUnit | ✅ 編譯時 | ✅ 測試覆蓋 |
| Agent 友善度 | ✅ 核心設計 | ❌ 非設計目標 | ❌ 人類工作坊 | ⚠️ DSL 需學習 | ❌ Java only | ⚠️ 非為 Agent 設計 |
| Token 效率 | ✅ 漸進式分裂 | N/A | N/A | ⚠️ DSL 可能冗長 | N/A | N/A |
| 增量更新 | ✅ Delta Spec | ❌ | N/A | ⚠️ DSL 版本控制 | N/A | N/A |
| BDD 整合 | ✅ 標記驅動 | ⚠️ 理論相容 | ✅ Event Mapping | ❌ | ❌ | ⚠️ 分離的測試 |
| 跨工具狀態 | ✅ Memory.md | ❌ | N/A | ❌ | N/A | N/A |

---

## 十、結論

你的 Agentic Coding Framework 對 DDD 的處理策略是「萃取精華、按需啟用」——從經典 DDD 的龐大體系中選擇了對 AI Agent 最有價值的三個面向：Context 隔離（解決 Context Window 限制）、Ubiquitous Language（解決命名一致性）、Aggregate Root 約束（解決封裝性）。這個萃取是精準的。

框架的 **三個獨特優勢**：

1. **漸進式分裂策略**：業界 DDD 通常要求「一次到位」的 Context 劃分，你的框架允許小專案併入 SDD、大專案才獨立——這大幅降低了 DDD 的導入門檻。

2. **Agent 可執行的 Ubiquitous Language**：傳統 Glossary 是給人看的文件，你的 Glossary 是 Agent 的命名指令（含類型約束和強制規則）——這是 DDD 在 AI 時代的自然演進。

3. **DDD × BDD × TDD 的完整鏈路**：經典 DDD 和 BDD 是獨立發展的實踐，你的框架把 DDD 的 Context Map 嵌入 SDD，SDD 驅動 BDD 場景的模組歸屬，BDD 標記驅動 TDD——形成了從戰略設計到可執行測試的完整推導鏈。

框架 **需要補強的方向** 主要集中在：

1. **發現流程**（Event Storming → Context Map → BDD 的銜接）——目前框架假設 Context 邊界已由人類決定，但沒有定義如何消費人類的發現成果。

2. **戰術設計深度**（Aggregate 設計原則、Domain Event 正式化、Entity vs. Value Object）——Level 3 打開了戰術設計的大門，但門內的指引不夠豐富。

3. **自動化驗證**（Constitution → ArchUnit / Fitness Function）——目前的架構約束完全依賴 Agent 的「自覺」，長期需要 CI 層級的自動驗證。

與 BDD/SDD/TDD 三份比較分析的一致發現：你的框架的核心定位——「服務 AI Agent 的專案上下文基礎建設」——決定了它對每個方法論的萃取策略：保留對 Agent 有價值的部分，省略只對人類有價值的部分。在 DDD 這個面向上，這個策略執行得最為徹底——三層漸進式設計讓團隊可以從零開始，只在需要時才深入，完全避免了傳統 DDD 的「全有全無」困境。
