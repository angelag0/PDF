"""
PDF 編輯器後端回歸測試
先啟動 python app.py，再執行 python test_api.py
每一項都會實際檢查結果，任何一項不符就停下並標出是哪一項。
"""
import sys
import os
import io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

import unicodedata
import fitz  # PyMuPDF
import requests
from PIL import Image

BASE = "http://localhost:5000"
HERE = os.path.dirname(os.path.abspath(__file__))
FONT = os.path.join(HERE, "fonts", "NotoSansTC-Regular.otf")

passed = 0


def check(cond, label):
    global passed
    if not cond:
        print(f"❌ {label}")
        sys.exit(1)
    passed += 1
    print(f"✓ {label}")


def png_bytes(color, size=(60, 40)):
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, "PNG")
    return buf.getvalue()


def build_sample():
    """做一份像表格的測試檔：有文字、表格線、圖片，共兩頁"""
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    font = fitz.Font(fontfile=FONT)
    tw = fitz.TextWriter(page.rect)
    tw.append((72, 100), "PDF 編輯器測試文件", font=font, fontsize=24)
    tw.append((72, 150), "申請人姓名", font=font, fontsize=12)
    tw.append((72, 165), "緊貼的下一行文字", font=font, fontsize=12)
    tw.append((72, 210), "Hello World", font=font, fontsize=14)
    tw.write_text(page)
    # 表格線：穿過「申請人姓名」那一行
    for y in (140, 170, 200):
        page.draw_line((60, y), (500, y), color=(0, 0, 0), width=1)
    page.draw_line((200, 140), (200, 200), color=(0, 0, 0), width=1)
    # 圖片：與 Hello World 重疊
    page.insert_image(fitz.Rect(100, 195, 250, 225), stream=png_bytes((0, 128, 255)), keep_proportion=False)

    page2 = doc.new_page(width=595, height=842)
    tw2 = fitz.TextWriter(page2.rect)
    tw2.append((72, 100), "第二頁", font=font, fontsize=24)
    tw2.write_text(page2)
    return doc.tobytes()


def upload(pdf_bytes, name="test.pdf"):
    r = requests.post(f"{BASE}/api/upload", files={"file": (name, pdf_bytes, "application/pdf")})
    return r.json()["doc_id"]


def render(doc_id, page=0):
    r = requests.get(f"{BASE}/api/page/{doc_id}/{page}?zoom=1")
    return Image.open(io.BytesIO(r.content)).convert("RGB")


def same(a, b):
    return a.size == b.size and a.tobytes() == b.tobytes()


def spans(doc_id, page=0):
    return requests.get(f"{BASE}/api/page/{doc_id}/{page}/text").json()["text_items"]


def find(doc_id, text, page=0):
    # 完整字型寫入的字可能被記成外觀相同的相容字（例如「行」記成 U+FA08），比對前先正規化
    norm = lambda t: unicodedata.normalize("NFKC", t).strip()
    return next((s for s in spans(doc_id, page) if norm(s["text"]) == norm(text)), None)


def post(path, **payload):
    return requests.post(f"{BASE}{path}", json=payload).json()


sample = build_sample()
doc_id = upload(sample)
original = render(doc_id)

print("\n=== 上一步不能在頁面上留下白塊 ===")
r = post("/api/text/add", doc_id=doc_id, page_num=0, x=300, y=150, text="王小明", font_size=14, color=[0, 0, 0])
check(r.get("success") and r["can_undo"], "加字成功，且可以上一步")
after_add = render(doc_id)
check(not same(original, after_add), "加字後畫面有變化")
r = post(f"/api/undo/{doc_id}")
check(r["can_redo"] and not r["can_undo"], "上一步後可以下一步")
check(same(render(doc_id), original), "上一步後畫面與原檔完全相同（沒有白塊）")
post(f"/api/redo/{doc_id}")
check(same(render(doc_id), after_add), "下一步後畫面與加字後完全相同")

print("\n=== 打字位置與輸入框一致 ===")
d2 = upload(sample)
post("/api/text/add", doc_id=d2, page_num=0, x=300, y=400, text="第一行\n第二行", font_size=20, color=[255, 0, 0])
l1, l2 = find(d2, "第一行"), find(d2, "第二行")
check(l1 and abs(l1["bbox"][0] - 300) < 0.5, f"左緣對齊點擊位置（{l1['bbox'][0]:.2f} ≈ 300）")
check(abs(l1["bbox"][1] - 400) < 0.5, f"上緣對齊輸入框上緣（{l1['bbox'][1]:.2f} ≈ 400）")
check(l2 and abs((l2["origin"][1] - l1["origin"][1]) - 20 * 1.448) < 0.5, "多行文字的行距＝輸入框的行高（1.448 倍字級）")
check(l1["color"] == 0xFF0000, "顏色正確（紅色）")
post("/api/text/add", doc_id=d2, page_num=0, x=300, y=500, text="行政區", font_size=12, color=[0, 0, 0])
raw = [s["text"] for s in spans(d2) if "政區" in s["text"]]
check(raw == ["行政區"], "加入的字之後可以正常搜尋、複製（內碼與輸入的相同）")

print("\n=== 匯出檔案不會被字型撐大 ===")
d_size = upload(sample)
base = len(requests.get(f"{BASE}/api/export/pdf/{d_size}").content)
post("/api/text/add", doc_id=d_size, page_num=0, x=300, y=400, text="王小明 A123456789 台北市信義區", font_size=12, color=[0, 0, 0])
grow = len(requests.get(f"{BASE}/api/export/pdf/{d_size}").content) - base
check(grow < 30_000, f"加一段字只讓檔案變大 {grow / 1024:.1f} KB（原本每次會多 16 MB）")

print("\n=== 刪字只拿掉那段字，不動表格線、圖片、隔壁行 ===")
d3 = upload(sample)
page_before = fitz.open("pdf", requests.get(f"{BASE}/api/export/pdf/{d3}").content)[0]
lines_before = len(page_before.get_drawings())
target = find(d3, "申請人姓名")
r = post("/api/text/delete", doc_id=d3, page_num=0, rects=[target["bbox"]])
check(r.get("success"), "刪除成功")
check(find(d3, "申請人姓名") is None, "目標文字已刪除")
check(find(d3, "緊貼的下一行文字") is not None, "緊貼的下一行文字還在")
page_after = fitz.open("pdf", requests.get(f"{BASE}/api/export/pdf/{d3}").content)[0]
check(len(page_after.get_drawings()) == lines_before, "表格線數量不變")
img = render(d3)
col = [original.getpixel((100, y)) for y in range(137, 144)]
check(min(sum(c) for c in col) < 600, "（前提）原檔在該處有表格線")
check([img.getpixel((100, y)) for y in range(137, 144)] == col, "穿過文字的表格線還在")
hello = find(d3, "Hello World")
r = post("/api/text/delete", doc_id=d3, page_num=0, rects=[hello["bbox"]])
px = render(d3).getpixel((130, 205))
check(abs(px[0] - 0) < 10 and abs(px[1] - 128) < 10 and abs(px[2] - 255) < 10, f"與文字重疊的圖片沒有被挖白（{px}）")
post(f"/api/undo/{d3}")
post(f"/api/undo/{d3}")
check(same(render(d3), original), "連按兩次上一步完全還原")

print("\n=== 修改文字沿用原位置、大小、顏色，且一步還原 ===")
d4 = upload(sample)
t = find(d4, "申請人姓名")
r = post("/api/text/replace", doc_id=d4, page_num=0, rects=[t["bbox"]], x=t["bbox"][0],
         baseline=t["origin"][1], text="被保險人姓名", font_size=t["size"], color=t["color"])
n = find(d4, "被保險人姓名")
check(n and find(d4, "申請人姓名") is None, "原文字換成新文字")
check(abs(n["origin"][1] - t["origin"][1]) < 0.5 and abs(n["size"] - t["size"]) < 0.1, "基線與字級沿用原本的")
post(f"/api/undo/{d4}")
check(same(render(d4), original), "按一次上一步就完整還原")

print("\n=== 圖片：一次合併多張算一步 ===")
d5 = upload(sample)
for i, c in enumerate([(255, 0, 0), (0, 255, 0)]):
    r = requests.post(f"{BASE}/api/image/add", data={
        "doc_id": d5, "page_num": 0, "rect": f"[{300 + i * 80}, 500, {360 + i * 80}, 540]",
        "snapshot": "1" if i == 0 else "0",
    }, files={"image": ("a.png", png_bytes(c), "image/png")}).json()
check(r.get("success"), "兩張圖片都放入")
post(f"/api/undo/{d5}")
check(same(render(d5), original), "一次上一步兩張一起拿掉")

print("\n=== 刪頁、裁切都能上一步 ===")
d6 = upload(sample)
r = post("/api/delete-pages", doc_id=d6, pages=[1])
check(r["page_count"] == 1, "刪掉第 2 頁")
r = post("/api/delete-pages", doc_id=d6, pages=[0])
check("error" in r, "只剩一頁時拒絕刪除")
r = post(f"/api/undo/{d6}")
check(r["page_count"] == 2, "上一步救回第 2 頁")
r = post("/api/crop", doc_id=d6, page_num=0, slices=[{"top": 0, "bottom": 300}, {"top": 500, "bottom": 842}])
check(r["page_count"] == 3, "第 1 頁切成兩段（共 3 頁）")
info = requests.get(f"{BASE}/api/doc/{d6}/info").json()
check(abs(info["pages"][0]["height"] - 300) < 0.5 and abs(info["pages"][1]["height"] - 342) < 0.5, "切出來的頁面高度正確")
r = post(f"/api/undo/{d6}")
check(r["page_count"] == 2 and same(render(d6), original), "上一步還原裁切")

print("\n=== 其他功能 ===")
r = requests.get(f"{BASE}/fonts/NotoSansTC-Regular.otf")
check(r.status_code == 200 and len(r.content) > 1_000_000, "瀏覽器可以載入輸入框用的字型")
r = requests.post(f"{BASE}/api/merge", data={"config": f'[{{"doc_id":"{d4}","pages":null}},{{"doc_id":"{d5}","pages":null}}]'})
check(r.status_code == 200 and fitz.open("pdf", r.content).page_count == 4, "合併兩份 PDF（共 4 頁）")
r = requests.get(f"{BASE}/api/export/jpg/{d2}")
check(r.status_code == 200 and r.content[:2] == b"PK", "匯出 JPG（ZIP）")
r = requests.get(f"{BASE}/api/export/docx/{d2}")
check(r.status_code == 200 and r.content[:2] == b"PK", "匯出 Word")
r = requests.get(f"{BASE}/api/page/nope/0/text")
check(r.status_code == 404, "文件不存在時回 404 而不是當機")

print("\n=== 有密碼的 PDF ===")
locked_src = fitz.open("pdf", sample)
locked_bytes = locked_src.tobytes(encryption=fitz.PDF_ENCRYPT_AES_256, user_pw="A123456789", owner_pw="owner")
r = requests.post(f"{BASE}/api/upload", files={"file": ("存摺.pdf", locked_bytes, "application/pdf")})
check(r.status_code == 401 and r.json().get("need_password") and not r.json().get("wrong"), "沒給密碼時要求輸入密碼")
r = requests.post(f"{BASE}/api/upload", data={"password": "wrong"}, files={"file": ("存摺.pdf", locked_bytes, "application/pdf")})
check(r.status_code == 401 and r.json().get("wrong"), "密碼錯誤時明確告知")
r = requests.post(f"{BASE}/api/upload", data={"password": "A123456789"}, files={"file": ("存摺.pdf", locked_bytes, "application/pdf")}).json()
check(r.get("locked") and r.get("page_count") == 2, "正確密碼可以開啟，並標示為有密碼")
d7 = r["doc_id"]
check(requests.get(f"{BASE}/api/doc/{d7}/info").status_code == 200, "開啟後可以讀取頁面資訊")
post("/api/text/add", doc_id=d7, page_num=0, x=300, y=600, text="已編輯", font_size=12, color=[0, 0, 0])
post(f"/api/undo/{d7}")
post(f"/api/redo/{d7}")
check(find(d7, "已編輯") is not None, "有密碼的檔案也能加字、上一步、下一步")
out = fitz.open("pdf", requests.get(f"{BASE}/api/export/pdf/{d7}").content)
check(out.needs_pass and not out.authenticate("wrong"), "匯出的 PDF 仍然需要密碼")
check(out.authenticate("A123456789") > 0, "用原本的密碼可以打開匯出檔")
text = unicodedata.normalize("NFKC", out[0].get_text())
check("申請人姓名" in text and "已編輯" in text, "匯出檔裡原本的內容與新加的字都在")
open_out = fitz.open("pdf", requests.get(f"{BASE}/api/export/pdf/{d7}?keep_password=0").content)
check(not open_out.needs_pass, "選「不要密碼」匯出的 PDF 不用密碼就能開")
check("已編輯" in unicodedata.normalize("NFKC", open_out[0].get_text()), "不要密碼的匯出檔內容完整")
post("/api/delete-pages", doc_id=d7, pages=[1])
cover = fitz.open("pdf", requests.get(f"{BASE}/api/export/pdf/{d7}?keep_password=0").content)
check(cover.page_count == 1 and not cover.needs_pass, "刪掉內頁、只匯出封面且不要密碼")
check(fitz.open("pdf", requests.get(f"{BASE}/api/export/pdf/{d7}").content).needs_pass, "沒選的話預設仍保留密碼")
r = requests.get(f"{BASE}/api/export/docx/{d7}")
check(r.status_code == 200 and r.content[:2] == b"PK", "有密碼的檔案也能匯出 Word")
owner_only = locked_src.tobytes(encryption=fitz.PDF_ENCRYPT_AES_256, owner_pw="owner", permissions=fitz.PDF_PERM_PRINT)
r = requests.post(f"{BASE}/api/upload", files={"file": ("限制編輯.pdf", owner_only, "application/pdf")}).json()
check(r.get("doc_id") and not r.get("locked"), "只有限制編輯、沒有開啟密碼的檔案可以直接開")
d8 = r["doc_id"]
post("/api/text/add", doc_id=d8, page_num=0, x=300, y=600, text="可編輯", font_size=12, color=[0, 0, 0])
check("可編輯" in fitz.open("pdf", requests.get(f"{BASE}/api/export/pdf/{d8}").content)[0].get_text(), "限制編輯的檔案加字後匯出正常")
r = requests.post(f"{BASE}/api/upload", files={"file": ("壞檔.pdf", b"not a pdf at all", "application/pdf")})
check(r.status_code == 400 and "打不開" in r.json()["error"], "壞掉的檔案給看得懂的錯誤訊息")
r = requests.get(f"{BASE}/api/page/{d8}/0?zoom=abc")
check(r.headers.get("Content-Type", "").startswith("application/json") and r.json().get("error"), "程式出錯時也回中文錯誤訊息，不是網頁")

print("\n=== 圖片：放原圖，不留邊框、方向正確 ===")
d9 = upload(sample)


def put_image(img_bytes, rect, rotate=0, name="a.png"):
    return requests.post(f"{BASE}/api/image/add", data={
        "doc_id": d9, "page_num": 0, "rect": str(list(rect)), "rotate": str(rotate),
    }, files={"image": (name, img_bytes, "application/octet-stream")}).json()


def jpg_bytes(img, exif_orientation=None):
    buf = io.BytesIO()
    if exif_orientation:
        exif = Image.Exif()
        exif[0x0112] = exif_orientation
        img.save(buf, "JPEG", quality=95, exif=exif)
    else:
        img.save(buf, "JPEG", quality=95)
    return buf.getvalue()


put_image(png_bytes((200, 30, 30), (80, 40)), (300, 600, 380, 640))
page_img = Image.open(io.BytesIO(requests.get(f"{BASE}/api/page/{d9}/0?zoom=4").content)).convert("RGB")
edge = [page_img.getpixel((300 * 4 + 1, y)) for y in range(600 * 4 + 1, 640 * 4 - 1, 7)] + \
       [page_img.getpixel((x, 600 * 4 + 1)) for x in range(300 * 4 + 1, 380 * 4 - 1, 7)]
check(all(abs(p[0] - 200) < 8 and abs(p[1] - 30) < 8 for p in edge), "圖片最外圈就是圖片本身的顏色（沒有深色或淺色細框）")
check(page_img.getpixel((300 * 4 - 2, 620 * 4)) == (255, 255, 255), "圖片外面沒有多出任何東西")


def marker_image(size=(40, 20)):
    img = Image.new("RGB", size, "white")
    for x in range(10):
        for y in range(10):
            img.putpixel((x, y), (255, 0, 0))
    return img


def red_corner(rect):
    px = Image.open(io.BytesIO(requests.get(f"{BASE}/api/page/{d9}/0?zoom=1").content)).convert("RGB")
    x0, y0, x1, y1 = rect
    corners = {"左上": (x0 + 3, y0 + 3), "右上": (x1 - 3, y0 + 3), "左下": (x0 + 3, y1 - 3), "右下": (x1 - 3, y1 - 3)}
    return [k for k, xy in corners.items() if px.getpixel(xy)[0] > 200 and px.getpixel(xy)[1] < 80]


buf = io.BytesIO(); marker_image().save(buf, "PNG")
put_image(buf.getvalue(), (100, 300, 140, 380), rotate=90)
check(red_corner((100, 300, 140, 380)) == ["右上"], "畫面上順時針轉 90 度，PDF 裡也是（紅角從左上轉到右上）")
# 手機照片：像素存成橫的、EXIF 標記「要順時針轉 90 度才是正的」
put_image(jpg_bytes(marker_image(), exif_orientation=6), (200, 300, 240, 380), name="photo.jpg")
check(red_corner((200, 300, 240, 380)) == ["右上"], "手機照片依 EXIF 方向轉正後才放入")

check(not os.path.exists(os.path.join(HERE, "uploads")), "開過的檔案不會複製到磁碟上")

for d in (doc_id, d2, d_size, d3, d4, d5, d6, d7, d8, d9):
    requests.post(f"{BASE}/api/close/{d}")

print(f"\n✅ 全部 {passed} 項通過")
