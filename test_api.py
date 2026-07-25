"""快速測試 PDF 編輯器後端 API"""
import sys
import os
import io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
sys.path.insert(0, os.path.dirname(__file__))

import fitz  # PyMuPDF
import requests
import json

BASE = "http://localhost:5000"

# 1. 建立測試 PDF
print("=== 建立測試 PDF ===")
doc = fitz.open()
page = doc.new_page(width=595, height=842)  # A4

# 加入中文文字
font_path = os.path.join(os.path.dirname(__file__), "fonts", "NotoSansTC-Regular.otf")
if os.path.exists(font_path):
    font = fitz.Font(fontfile=font_path)
else:
    font = fitz.Font("helv")

tw = fitz.TextWriter(page.rect)
tw.append((72, 100), "PDF 編輯器測試文件", font=font, fontsize=24)
tw.append((72, 150), "這是一段中文測試文字，用來驗證文字選取和刪除功能。", font=font, fontsize=14)
tw.append((72, 180), "Hello World - English Text Test", font=font, fontsize=14)
tw.append((72, 210), "第一頁內容", font=font, fontsize=12)
tw.write_text(page)

# 第二頁
page2 = doc.new_page(width=595, height=842)
tw2 = fitz.TextWriter(page2.rect)
tw2.append((72, 100), "第二頁", font=font, fontsize=24)
tw2.append((72, 150), "更多測試內容在這裡。", font=font, fontsize=14)
tw2.write_text(page2)

test_pdf = os.path.join(os.path.dirname(__file__), "test_sample.pdf")
doc.save(test_pdf)
doc.close()
print(f"✓ 測試 PDF 已建立: {test_pdf}")

# 2. 上傳 PDF
print("\n=== 上傳 PDF ===")
with open(test_pdf, "rb") as f:
    resp = requests.post(f"{BASE}/api/upload", files={"file": ("test.pdf", f, "application/pdf")})
data = resp.json()
print(f"✓ 上傳成功: doc_id={data['doc_id']}, pages={data['page_count']}")
doc_id = data["doc_id"]

# 3. 取得文件資訊
print("\n=== 文件資訊 ===")
resp = requests.get(f"{BASE}/api/doc/{doc_id}/info")
info = resp.json()
print(f"✓ 頁數: {info['page_count']}, 第一頁尺寸: {info['pages'][0]}")

# 4. 渲染頁面
print("\n=== 渲染頁面 ===")
resp = requests.get(f"{BASE}/api/page/{doc_id}/0?zoom=2")
print(f"✓ 頁面圖片大小: {len(resp.content)} bytes, Content-Type: {resp.headers['Content-Type']}")

# 5. 取得縮圖
print("\n=== 取得縮圖 ===")
resp = requests.get(f"{BASE}/api/thumbnail/{doc_id}/0")
print(f"✓ 縮圖大小: {len(resp.content)} bytes")

# 6. 提取文字
print("\n=== 提取文字 ===")
resp = requests.get(f"{BASE}/api/page/{doc_id}/0/text")
text_data = resp.json()
print(f"✓ 找到 {len(text_data['text_items'])} 個文字區塊")
for item in text_data["text_items"][:3]:
    print(f"  - '{item['text']}' at {item['bbox']}")

# 7. 新增文字
print("\n=== 新增文字 ===")
resp = requests.post(f"{BASE}/api/text/add", json={
    "doc_id": doc_id,
    "page_num": 0,
    "x": 72,
    "y": 300,
    "text": "新增的中文文字測試！",
    "font_size": 18,
    "color": [255, 0, 0],
})
print(f"✓ 新增文字: {resp.json()}")

# 8. 匯出 PDF
print("\n=== 匯出 PDF ===")
resp = requests.get(f"{BASE}/api/export/pdf/{doc_id}")
print(f"✓ 匯出 PDF 大小: {len(resp.content)} bytes")

# 9. 匯出 JPG
print("\n=== 匯出 JPG ===")
resp = requests.get(f"{BASE}/api/export/jpg/{doc_id}/0")
print(f"✓ 匯出 JPG 大小: {len(resp.content)} bytes")

# 10. 裁切預覽
print("\n=== 裁切預覽 ===")
resp = requests.post(f"{BASE}/api/crop/preview", json={
    "doc_id": doc_id,
    "page_num": 0,
    "cut_lines": [200, 400],
})
crop_data = resp.json()
print(f"✓ 切片數: {len(crop_data['slices'])}")
for s in crop_data['slices']:
    print(f"  - 切片 {s['index']}: top={s['top']}, bottom={s['bottom']}")

print("\n✅ 所有 API 測試通過！")

# 清理
os.remove(test_pdf)
