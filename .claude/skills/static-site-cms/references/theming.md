# 設計後台介面

後台的長相完全由 `theme.css` 最上面的 CSS 變數決定；版面規則只引用變數。要「自己設計 UI」時照這個順序：

## 1. 先決定變數

| 變數 | 用途 |
| --- | --- |
| `--bg` | 整個後台底色 |
| `--panel` / `--panel-2` | 側欄、頂列 / 輸入框、hover 列 |
| `--ink` / `--muted` | 主要文字 / 次要文字 |
| `--line` | 邊框 |
| `--accent` / `--accent-ink` | 主要按鈕、選取框、模式切換 / 其上的文字 |
| `--danger` / `--ok` | 刪除、錯誤 / 成功 |
| `--stage` | 畫布四周的底色（裝置寬度模式時看得到） |
| `--radius` | 圓角（像素風網站用 0–2px，圓潤風格 12px+） |
| `--font` / `--mono` | 介面字體 / 路徑與標籤字體 |
| `--shadow` | 對話框與裝置框陰影 |
| `color-scheme` | `light` 或 `dark`，讓捲軸與原生控制項配色一致 |

畫布上的選取框顏色自動取 `--accent`。

## 2. 「配合網站」主題

把 analyze.py 列出的 `:root` 變數對應過來，改寫 `[data-ui-theme="site"]`：
- 網站背景 → `--bg`，稍亮／稍暗一階 → `--panel`、`--panel-2`
- 網站內文色 → `--ink`，次要色 → `--muted`，分隔線 → `--line`
- 網站的強調色或連結色 → `--accent`（確認 `--accent-ink` 在它上面對比 ≥ 4.5:1）
- 網站的字體堆疊 → `--font`（後台沿用網站字型會很有一致感；網站字型是透過 Google Fonts 載入的話，後台 `index.html` 也要加相同的 `<link>`）
- 網站很方正（像素、復古）→ `--radius: 0–2px`

後台介面要比網站「安靜」：把網站最強烈的顏色只用在 `--accent`，其餘用中性色，讓注意力留在畫布上。

## 3. 使用者描述的風格

使用者說「可愛粉色」「極簡黑白」「像 Notion」之類，就新增一組 `[data-ui-theme="自訂名稱"]`，並在 `index.html` 的 `#ui-theme` 加一個 `<option>`，`cms.config.json` 的 `ui.theme` 設成它。

## 4. 版面

- `ui.side`：屬性面板放 `right`（預設）或 `left`
- `ui.outline`：`false` 隱藏左側結構面板（頁面很單純時）
- `ui.density`：`comfy` / `compact`
- 更大的改動（例如把屬性面板做成浮動卡片、頂列移到底部）直接改 `theme.css` 的 layout 區塊；`index.html` 的 class 名稱都是語意化的（`.topbar`、`.panel-outline`、`.stage`、`.panel-inspect`、`.card`）。改完務必用 390px 寬度截圖檢查手機版。

## 5. 使用者自己調

後台右上 ◐ 可即時切換主題、強調色、面板位置、密度、結構面板開關，存在該瀏覽器；「還原預設」回到 `cms.config.json` 的 `ui` 設定。
