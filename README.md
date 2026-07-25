# PDF 編輯器 (PDF Editor)

一個強大、跨平台且完全基於本機運作的 PDF 編輯器 Web 應用程式。結合 Flask 後端、PyMuPDF (fitz) PDF 處理引擎與現代化 Web 前端 UI（Fabric.js 畫布 + 深色玻璃擬態設計）。

---

## 🌟 主要功能

1. **文字選取、編輯與刪除**
   - 在 PDF 畫布上框選文字段落或多選文字。
   - 右側側邊欄即時顯示文字內容，可**直接在文字框內修改內文**並點選「修改文字」存檔更新。
   - 支援文字複製與一鍵刪除。

2. **圖片貼上、調整與合併**
   - 支援拖放上傳圖片或直接從剪貼簿貼上 (Ctrl+V)。
   - 提供 Fabric.js 互動畫布，支援圖片拖拽移動、自由縮放、旋轉。
   - 點擊「確認合併進 PDF」將圖片精確嵌入 PDF。

3. **打字與字型設定**
   - 任意位置點擊新增文字。
   - 可自由設定字型大小 (6-200pt)、顏色 (Picker / HEX)。
   - **完整支援中文字型**（內建 Google Noto Sans TC 思源黑體）。

4. **多 PDF 合併與頁面排序**
   - 專屬合併模式介面。
   - 支援上傳多份 PDF 檔案，並可自由**拖拽調整合併順序**。

5. **頁面裁切與刪除切片**
   - 可在頁面上新增任意數量的水平切割線（支援滑鼠拖拽位置）。
   - 預覽切割切片，手動切換保留/刪除特定切片。

6. **多格式匯出**
   - 匯出為編輯後的 PDF。
   - 匯出為高畫質 JPG 圖片（ZIP 打包或單頁）。
   - 匯出為 Word (.docx) 文件。

---

## 🚀 快速啟動指南

### 環境需求
- Python 3.9+ 

### 1. 安裝套件依賴
在專案根目錄執行：
```bash
pip install -r requirements.txt
```

### 2. 啟動應用程式
```bash
python app.py
```

啟動後，開啟瀏覽器訪問：
👉 **http://localhost:5000**

---

## 🎹 常用快捷鍵

| 快捷鍵 | 功能 |
|---|---|
| `Ctrl + Z` | 復原 (Undo) |
| `Ctrl + Y` / `Ctrl + Shift + Z` | 重做 (Redo) |
| `Ctrl + C` | 複製選取文字 |
| `Delete` | 刪除選取文字 |
| `Ctrl + 滾輪` | 頁面縮放 |
| `PageUp / PageDown` | 上/下一頁 |
| `Escape` | 取消當前動作 |

---

## 📁 專案架構

```
PDF/
├── app.py                  # Flask 主程式與 API 路由
├── pdf_engine.py           # PyMuPDF 核心處理引擎
├── requirements.txt        # 專案依賴庫
├── fonts/                  # 內建中文字型目錄
│   └── NotoSansTC-Regular.otf
├── static/
│   ├── css/
│   │   └── style.css       # 深色 UI 設計系統
│   └── js/
│       ├── app.js          # 主控制邏輯
│       ├── pdf-viewer.js   # PDF 檢視器
│       ├── text-editor.js  # 文字選取與編輯
│       ├── image-editor.js # 圖片 Fabric 畫布
│       ├── crop-editor.js  # 水平裁切引擎
│       ├── merge-editor.js # 合併排序邏輯
│       ├── undo-manager.js # 復原/重做管理
│       └── fabric.min.js   # Fabric.js 畫布庫
└── templates/
    └── index.html          # 主介面 HTML
```
