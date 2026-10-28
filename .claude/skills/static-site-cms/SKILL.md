---
name: static-site-cms
description: 把一個純靜態網站（手寫的 HTML/CSS/JS，例如 GitHub Pages）變成可以「在畫布上直接編輯、即時看到結果」的內容後台。會先分析網站結構，再產生 admin/ 後台：真實網頁載入在畫布裡，點文字直接打字、點圖片替換、區塊可上移／下移／複製／刪除，草稿自動儲存，一鍵發佈到本機資料夾或 GitHub。後台介面（配色、字體、版面）可以依使用者喜好自訂。Use when the user wants a CMS, admin panel, back office, visual / WYSIWYG / inline / on-canvas editor, or "後台", "可編輯內容", "所見即所得", "即時預覽" for a static HTML site.
---

# 靜態網站 → 畫布即時編輯後台

產出的後台不是「表單 + 存檔 + 開新分頁預覽」，而是**直接在真實網頁上編輯**：網頁原封不動地載入在 iframe 畫布裡（網站自己的 CSS、字體、JS 都在跑），使用者點哪裡改哪裡，畫面當下就是訪客會看到的樣子。

## 運作原理（修改模板前一定要懂）

- `template/cms.js` 用 parse5（`template/vendor/parse5.min.js`，已打包、免網路）解析原始 HTML，取得每個元素在原始碼中的**位置**，再把 `data-cms-id` 插進每個起始標籤，用 `srcdoc` 載入 iframe。
- 存檔時**不會**把 live DOM 序列化回去（網站自己的 JS 會在執行時改 DOM：隱藏視窗、加按鈕、改時鐘…）。而是只把使用者做過的修改（文字 innerHTML、屬性、子元素順序、新增的區塊）**補丁回原始文字**。沒動過的地方逐字不變 → git diff 乾淨。
- 因此：網站 JS 在執行時產生的元素沒有 `data-cms-id`，永遠不能編輯；JS 會改寫內容的元素要放進 `locked`。
- 只適用「手寫的 HTML 就是正式檔案」的網站。如果 HTML 是 Jekyll / Hugo / Astro / Vite 等產生的，要告訴使用者應該改原始檔，這個工具只會改到產出的檔案。

## 流程

### 1. 分析網站

```bash
python3 .claude/skills/static-site-cms/scripts/analyze.py <網站根目錄>
```

報告會列出：頁面（標出 meta refresh 轉址頁）、建置工具跡象、重複的兄弟元素（`repeat` 候選）、腳本會用到或改寫的 selector（`locked` 候選）、圖片資料夾（`assetsDir`）、`:root` CSS 變數（後台 `site` 主題的配色依據）。

報告只是起點。**一定要自己讀頁面原始碼與 script**，搞清楚：
- 哪些區塊預設隱藏、要靠 JS 打開（例如視窗、分頁、摺疊）→ 放進 `outline` 並設定 `reveal`，讓使用者從「頁面結構」一鍵打開來編輯。
- 哪些元素的文字是 JS 寫的（時鐘、計數器、打字效果）→ `locked`。
- 哪些重複單位對使用者有意義（卡片、文章、圖片、標籤、清單項目）→ `repeat`，用使用者的語言取 `label`。
- 有沒有資訊藏在屬性裡（`data-title`、`title`、`aria-label`、`datetime`…）→ `fields`。

### 2. 問使用者後台要長什麼樣子（UI 可以自己設計）

用 AskUserQuestion 問一次就好，例如：
- 後台配色：配合網站風格（預設，從 `:root` 取色）／明亮／深色／紙張／使用者自己描述的風格
- 強調色、字體、面板在左或右、密度
- 要不要額外的介面需求（例如品牌名稱、只開放部分頁面）

使用者若沒意見就用「配合網站」。細節見 `references/theming.md`。後台右上角的 ◐ 也能讓使用者之後自己即時調整。

### 3. 安裝後台

```bash
mkdir -p admin && cp -r .claude/skills/static-site-cms/template/{index.html,cms.js,theme.css,vendor} admin/
```

- 目錄名預設 `admin/`，使用者想要別的名字就改，`siteRoot` 跟著調整（後台到網站根目錄的相對路徑）。
- 寫 `admin/cms.config.json`（完整欄位見 `references/config.md`）。
- 依第 2 步改寫 `admin/theme.css` 的 `[data-ui-theme="site"]` 預設（或新增一組），並在設定檔 `ui.theme` 指定。
- 介面文字預設是繁體中文；使用者用別的語言就把 `index.html` 與 `cms.js` 裡的字串翻過去。
- 若網站會公開部署（GitHub Pages），後台也會被公開，但沒有權杖就只能看、不能改。`index.html` 已有 `noindex`。若使用者不想公開，加進 `.gitignore`，改用本機開啟。

### 4. 驗證（必做）

```bash
python3 -m http.server 8123   # 在網站根目錄
```

用預裝的 Playwright（`require('playwright')`，不要重新安裝）開 `http://localhost:8123/admin/`，至少檢查：
1. 載入後 `await page.evaluate(() => __cms.render())` 與原始檔**完全相同**（逐位元組）。不同就代表解析有問題，先修。
2. 點文字打字 → 畫面立即變化，`__cms.render()` 與原檔的 diff 只有那一行。
3. 用「頁面結構」打開隱藏區塊並編輯；試一個 `repeat` 的上移／複製／刪除；替換一張圖片。
4. 一路按 ↶ 復原到底，`render()` 回到與原檔相同。
5. 重新整理頁面 → 草稿自動接續。
6. 「☝ 操作」模式下網站自己的互動照常運作，切回編輯後存檔不會帶入執行時的狀態。
7. 截圖給自己看一次：後台配色、選取框、手機寬度（390px）都正常。
8. 沒有 pageerror。

GitHub 發佈可以用 `context.route('https://api.github.com/**', …)` 模擬 API 測流程。

### 5. 交付

跟使用者說明：
- 怎麼打開後台：本機 `python3 -m http.server` 後開 `/admin/`；或部署後開 `https://<網站>/admin/`。
- 三種發佈方式：**本機資料夾**（Chrome/Edge，寫回檔案，自己 commit）、**GitHub**（需要 fine-grained token，只給這個 repo 的 Contents 讀寫；會直接 commit 到設定的分支，Pages 約一分鐘後更新）、**下載檔案**。
- 限制：複製出來的新區塊不會自動接上網站原本的 JS 互動（例如新視窗不會自動出現在工作列），要發佈後重新整理才會被網站的 JS 處理；有些網站需要同步新增對應的按鈕或選單項目。

## 後台功能速覽（寫說明給使用者時參考）

| 動作 | 方式 |
| --- | --- |
| 改文字 | 點一下直接打字；Enter 在段落／清單會新增下一段，Shift+Enter 換行，Esc 結束 |
| 格式 | 右側 B / I / S / 連結 / 清除格式，或 Ctrl/⌘+B、I |
| 改連結 | 選到連結後右側改網址、勾「新分頁」 |
| 換圖片 | 點圖 →「替換圖片…」，或把圖檔直接拖到圖上；寬高屬性會自動更新 |
| 區塊 | 右側「區塊」卡片：上移、下移、複製、刪除 |
| 隱藏內容 | 左側「頁面結構」點一下自動打開；或切到「☝ 操作」像訪客一樣點開 |
| 裝置寬度 | 上方 ▭ ▯ ▮（桌機／平板／手機） |
| 復原 | ↶ ↷ 或 Ctrl/⌘+Z、Ctrl/⌘+Shift+Z |
| 草稿 | 每次修改自動存在瀏覽器（圖片存在 IndexedDB），重新整理會接續 |
| 發佈 | 「發佈」或 Ctrl/⌘+S；發佈前會檢查檔案是否被別人改過 |

## 檔案

- `template/index.html` — 後台外框（頂列、結構面板、畫布、屬性面板、發佈與外觀對話框）
- `template/cms.js` — 編輯器本體（解析、補丁式存檔、畫布互動、復原、草稿、三種發佈）
- `template/theme.css` — 只靠 CSS 變數的主題，含 light / dark / paper / site 四組預設
- `template/vendor/parse5.min.js` — 打包好的 parse5 7.1.2（MIT）
- `scripts/analyze.py` — 網站分析（只用標準函式庫）
- `references/config.md` — `cms.config.json` 每個欄位
- `references/theming.md` — 怎麼依使用者喜好設計後台介面
