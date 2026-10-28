# `cms.config.json`

放在後台資料夾（與 `index.html` 同層）。所有 selector 都是標準 CSS selector，在**被編輯的網頁**上比對。

```jsonc
{
  "siteName": "我的網站",          // 顯示在後台左上角與分頁標題
  "siteRoot": "../",               // 後台 → 網站根目錄的相對路徑
  "pages": [                        // 可編輯的頁面（路徑相對網站根目錄）；轉址頁不要放
    { "path": "index.html", "label": "首頁" },
    { "path": "about/index.html", "label": "關於" }
  ],
  "assetsDir": "img",              // 新上傳圖片放哪（相對網站根目錄）

  "text": [".tag", ".btn"],        // 額外視為「文字區塊」的 selector（預設已含 h1–h6、p、li、a、span、button…）
  "locked": ["#clock", ".ticker"], // 永遠不能編輯（JS 會改寫或產生的區域）。script/style/svg/表單元素等已內建鎖定

  "repeat": [                       // 可上移／下移／複製／刪除的區塊，順序 = 判斷優先度無關，選取時會列出所有符合的祖先
    { "selector": ".card", "label": "卡片", "title": "text:h3" },
    { "selector": "dl.spec > dt", "label": "欄位", "span": 2 },  // span: 一個單位包含後面幾個兄弟（dt+dd）
    { "selector": "p", "label": "段落" }
  ],

  "fields": [                       // 選到元素（或其祖先）時，右側出現的屬性輸入框
    { "selector": ".win", "attr": "data-title", "label": "視窗名稱" },
    { "selector": "time", "attr": "datetime", "label": "日期（機器可讀）" },
    { "selector": "img.hero", "attr": "title", "label": "滑鼠提示", "type": "textarea" }
  ],

  "outline": [                      // 左側「頁面結構」；點了會捲過去並解除隱藏
    { "selector": "section[id]", "label": "text:h2", "reveal": ".body" }
  ],

  "github": { "owner": "me", "repo": "site", "branch": "main", "dir": "" },  // dir：網站在 repo 的子資料夾（例如 docs）
  "publish": { "default": "github" },   // folder | github | download（使用者第一次發佈時預選）
  "ui": { "theme": "site", "accent": "", "side": "right", "density": "comfy", "outline": true }
}
```

## `label` / `title` 格式

- `"attr:data-title"` — 取元素的屬性
- `"text:h2"` — 取元素內第一個符合 selector 的文字
- `"text"` — 取元素自己的文字
- 省略 — 用 `tag.class` 描述

## 選擇原則

- **text**：點擊時會往上找「最外層的連續文字區塊」——元素本身有文字、或符合 text selector，且子元素都是 inline（span、b、a、br…）。含 svg / video / 表單元素的不算。所以點 `<dd><span class="num">20</span> 歲</dd>` 的數字會編輯整個 `dd`。若某種卡片被整個當成一段文字（例如 `<a class="card">` 裡只有 inline 元素），把它內部的子元素加進 `text` 或把卡片本身加進 `locked` 再個別開放。
- **locked**：analyze.py「Selectors referenced」與「DOM writes」交叉比對；凡是 JS 會寫入文字或子元素的容器都鎖起來。只被 JS 切換 `hidden` / class 的元素**不用**鎖——那些執行時狀態本來就不會被存。
- **repeat**：從使用者角度命名（「作品」比「div.card」好）。巢狀沒關係，右側會由內而外列出每一層。只放真的會想增刪排序的東西；`p`、`li` 這類通用的放最後當備援。
- **outline**：預設隱藏的區塊（tab、modal、手風琴、視窗）一定要列，並用 `reveal` 指定內部也要解除 `hidden` 的元素；`<details>` 祖先會自動展開。

## 已知限制

- 複製出來的區塊是從原始碼複製（不帶執行時狀態），`id` 會自動加上 `-2` 之類的後綴避免重複。
- 被 JS 動態產生、原始碼裡不存在的內容（例如從 JSON 讀進來渲染的列表）無法用這個工具編輯；那種網站要改成編輯 JSON 資料檔。
- `<template>` 內容與 `<head>`（`<title>`、meta）不在畫布上編輯。`fields` 只會比對選到的元素與它在 `<body>` 裡的祖先。
