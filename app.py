"""
PDF 編輯器 — Flask 主程式
提供所有 REST API 端點
"""
import os
import io
import json
import zipfile
import atexit
import tempfile
import threading
from flask import Flask, request, jsonify, send_file, render_template, send_from_directory
from werkzeug.exceptions import HTTPException
from pdf_engine import PDFEngine, PasswordRequired

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 200 * 1024 * 1024  # 200MB max


class SerializeRequests:
    """
    PDF 套件不支援多執行緒同時操作，一次只處理一個請求
    （例如縮圖並行載入時，才不會兩個請求同時碰同一份文件）
    """

    def __init__(self, wsgi_app):
        self.wsgi_app = wsgi_app
        self.lock = threading.Lock()

    def __call__(self, environ, start_response):
        with self.lock:
            result = self.wsgi_app(environ, start_response)
            try:
                return [b"".join(result)]
            finally:
                if hasattr(result, "close"):
                    result.close()


app.wsgi_app = SerializeRequests(app.wsgi_app)


@app.errorhandler(Exception)
def handle_error(e):
    """所有錯誤都回 JSON，前端才能顯示看得懂的訊息"""
    if isinstance(e, HTTPException):
        messages = {404: "找不到這個資源", 413: "檔案太大（上限 200MB）"}
        return jsonify({"error": messages.get(e.code, e.description)}), e.code
    app.logger.exception(e)
    return jsonify({"error": f"程式發生錯誤：{e}"}), 500

# 初始化 PDF 引擎
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
engine = PDFEngine(
    upload_dir=os.path.join(BASE_DIR, "uploads"),  # 只用來清掉舊版留下的暫存檔
    font_dir=os.path.join(BASE_DIR, "fonts"),
)

# 程式結束時清理資源
atexit.register(engine.cleanup_all)


# ========================
# 頁面路由
# ========================

@app.route("/")
def index():
    """主頁面"""
    return render_template("index.html")


@app.route("/fonts/<path:name>")
def font_file(name):
    """讓瀏覽器用跟 PDF 相同的字型顯示輸入框，所見即所得"""
    return send_from_directory(os.path.join(BASE_DIR, "fonts"), name, max_age=86400)


def ok(doc_id, **extra):
    """修改成功：一併回傳頁數與能否上一步／下一步"""
    return jsonify({"success": True, **engine.history_state(doc_id), **extra})


# ========================
# PDF 上傳與基本資訊
# ========================

@app.route("/api/upload", methods=["POST"])
def upload_pdf():
    """上傳 PDF 檔案"""
    if "file" not in request.files:
        return jsonify({"error": "未選擇檔案"}), 400

    file = request.files["file"]
    if file.filename == "":
        return jsonify({"error": "未選擇檔案"}), 400

    if not file.filename.lower().endswith(".pdf"):
        return jsonify({"error": "僅支援 PDF 檔案"}), 400

    try:
        doc_id, page_count = engine.load_pdf(file, file.filename, request.form.get("password") or None)
    except PasswordRequired as e:
        return jsonify({
            "need_password": True,
            "wrong": e.wrong,
            "error": "密碼不正確" if e.wrong else "這份 PDF 需要密碼才能開啟",
        }), 401
    except Exception as e:
        return jsonify({"error": f"檔案打不開，可能不是 PDF 或檔案已損壞（{e}）"}), 400

    return jsonify({
        "doc_id": doc_id,
        "filename": engine.documents[doc_id]["filename"],
        "page_count": page_count,
        "locked": engine.is_locked(doc_id),
    })


@app.route("/api/doc/<doc_id>/info")
def doc_info(doc_id):
    """取得文件資訊"""
    doc = engine.get_doc(doc_id)
    if not doc:
        return jsonify({"error": "文件不存在"}), 404

    pages_info = []
    for i in range(doc.page_count):
        info = engine.get_page_info(doc_id, i)
        pages_info.append(info)

    return jsonify({
        "doc_id": doc_id,
        "page_count": doc.page_count,
        "pages": pages_info,
    })


# ========================
# 頁面渲染
# ========================

@app.route("/api/page/<doc_id>/<int:page_num>")
def get_page(doc_id, page_num):
    """渲染頁面為 PNG 圖片"""
    zoom = float(request.args.get("zoom", 2.0))
    result = engine.render_page(doc_id, page_num, zoom)
    if not result:
        return jsonify({"error": "頁面不存在"}), 404

    img_bytes, width, height = result
    response = send_file(
        io.BytesIO(img_bytes),
        mimetype="image/png",
    )
    response.headers["X-Page-Width"] = str(width)
    response.headers["X-Page-Height"] = str(height)
    return response


@app.route("/api/thumbnail/<doc_id>/<int:page_num>")
def get_thumbnail(doc_id, page_num):
    """取得頁面縮圖"""
    width = int(request.args.get("width", 200))
    img_bytes = engine.render_thumbnail(doc_id, page_num, width)
    if not img_bytes:
        return jsonify({"error": "頁面不存在"}), 404

    return send_file(io.BytesIO(img_bytes), mimetype="image/png")


@app.route("/api/thumbnails/<doc_id>")
def get_all_thumbnails(doc_id):
    """取得所有頁面縮圖資訊（返回 URL 列表）"""
    doc = engine.get_doc(doc_id)
    if not doc:
        return jsonify({"error": "文件不存在"}), 404

    thumbnails = []
    for i in range(doc.page_count):
        thumbnails.append({
            "page_num": i,
            "url": f"/api/thumbnail/{doc_id}/{i}",
        })
    return jsonify({"thumbnails": thumbnails})


# ========================
# 文字操作
# ========================

@app.route("/api/page/<doc_id>/<int:page_num>/text")
def get_page_text(doc_id, page_num):
    """取得頁面文字與座標"""
    result = engine.get_page_text_blocks(doc_id, page_num)
    if result is None:
        return jsonify({"error": "頁面不存在"}), 404

    text_items, page_width, page_height = result
    return jsonify({
        "text_items": text_items,
        "page_width": page_width,
        "page_height": page_height,
    })


@app.route("/api/text/delete", methods=["POST"])
def delete_text():
    """刪除指定區域文字（rects 可一次多塊，算一步上一步）"""
    data = request.json or {}
    doc_id = data.get("doc_id")
    page_num = data.get("page_num")
    rects = data.get("rects") or ([data["rect"]] if data.get("rect") else [])

    if not doc_id or page_num is None or not rects:
        return jsonify({"error": "缺少必要參數"}), 400
    if not engine.get_doc(doc_id):
        return jsonify({"error": "文件不存在，請重新開啟檔案"}), 404

    engine.snapshot(doc_id)
    if engine.delete_text_in_rects(doc_id, page_num, rects):
        return ok(doc_id)
    engine.rollback(doc_id)
    return jsonify({"error": "刪除失敗"}), 500


@app.route("/api/text/add", methods=["POST"])
def add_text():
    """在指定位置新增文字；(x, y) 是文字框左上角（PDF 座標）"""
    data = request.json or {}
    doc_id = data.get("doc_id")
    page_num = data.get("page_num")
    x = data.get("x")
    y = data.get("y")
    text = data.get("text", "")
    font_size = float(data.get("font_size", 12))
    color = data.get("color", [0, 0, 0])

    if not all([doc_id, page_num is not None, x is not None, y is not None, text.strip()]):
        return jsonify({"error": "缺少必要參數"}), 400
    if not engine.get_doc(doc_id):
        return jsonify({"error": "文件不存在，請重新開啟檔案"}), 404

    engine.snapshot(doc_id)
    if engine.add_text(doc_id, page_num, x, y, text, font_size, color, anchor="top"):
        return ok(doc_id)
    engine.rollback(doc_id)
    return jsonify({"error": "新增失敗"}), 500


@app.route("/api/text/replace", methods=["POST"])
def replace_text():
    """修改文字：刪掉原文字、在原基線寫入新文字，算一步上一步"""
    data = request.json or {}
    doc_id = data.get("doc_id")
    page_num = data.get("page_num")
    rects = data.get("rects") or []
    x = data.get("x")
    baseline = data.get("baseline")
    text = data.get("text", "")
    font_size = float(data.get("font_size", 12))
    color = data.get("color", 0)

    if not all([doc_id, page_num is not None, rects, x is not None, baseline is not None, text.strip()]):
        return jsonify({"error": "缺少必要參數"}), 400
    if not engine.get_doc(doc_id):
        return jsonify({"error": "文件不存在，請重新開啟檔案"}), 404

    engine.snapshot(doc_id)
    if engine.replace_text(doc_id, page_num, rects, x, baseline, text, font_size, color):
        return ok(doc_id)
    engine.rollback(doc_id)
    return jsonify({"error": "修改失敗"}), 500


@app.route("/api/undo/<doc_id>", methods=["POST"])
def undo(doc_id):
    if not engine.get_doc(doc_id):
        return jsonify({"error": "文件不存在，請重新開啟檔案"}), 404
    done = engine.undo(doc_id)
    return ok(doc_id, done=done)


@app.route("/api/redo/<doc_id>", methods=["POST"])
def redo(doc_id):
    if not engine.get_doc(doc_id):
        return jsonify({"error": "文件不存在，請重新開啟檔案"}), 404
    done = engine.redo(doc_id)
    return ok(doc_id, done=done)


# ========================
# 圖片操作
# ========================

@app.route("/api/image/add", methods=["POST"])
def add_image():
    """嵌入圖片到指定位置"""
    doc_id = request.form.get("doc_id")
    page_num = int(request.form.get("page_num", 0))
    rect = json.loads(request.form.get("rect", "[]"))  # [x0, y0, x1, y1]
    rotate = int(request.form.get("rotate", 0))

    if "image" not in request.files:
        return jsonify({"error": "未上傳圖片"}), 400

    img_file = request.files["image"]
    img_bytes = img_file.read()

    if not all([doc_id, rect]):
        return jsonify({"error": "缺少必要參數"}), 400
    if not engine.get_doc(doc_id):
        return jsonify({"error": "文件不存在，請重新開啟檔案"}), 404

    if request.form.get("snapshot", "1") == "1":
        engine.snapshot(doc_id)
    try:
        engine.add_image(doc_id, page_num, img_bytes, rect, rotate)
    except Exception as e:
        engine.rollback(doc_id)
        return jsonify({"error": f"嵌入失敗: {e}"}), 500
    return ok(doc_id)


# ========================
# 頁面操作
# ========================

@app.route("/api/delete-pages", methods=["POST"])
def delete_pages():
    """刪除指定頁面"""
    data = request.json
    doc_id = data.get("doc_id")
    pages = data.get("pages", [])

    if not doc_id or not pages:
        return jsonify({"error": "缺少必要參數"}), 400

    doc = engine.get_doc(doc_id)
    if not doc:
        return jsonify({"error": "文件不存在，請重新開啟檔案"}), 404
    if len(set(p for p in pages if 0 <= p < doc.page_count)) >= doc.page_count:
        return jsonify({"error": "至少需保留一頁"}), 400

    engine.snapshot(doc_id)
    engine.delete_pages(doc_id, pages)
    return ok(doc_id)


# ========================
# 裁切
# ========================

@app.route("/api/crop", methods=["POST"])
def crop_page():
    """裁切頁面"""
    data = request.json
    doc_id = data.get("doc_id")
    page_num = data.get("page_num")
    slices = data.get("slices", [])  # [{"top": float, "bottom": float}, ...]

    if not all([doc_id, page_num is not None, slices]):
        return jsonify({"error": "缺少必要參數"}), 400

    if not engine.get_doc(doc_id):
        return jsonify({"error": "文件不存在，請重新開啟檔案"}), 404

    engine.snapshot(doc_id)
    if engine.apply_crop(doc_id, page_num, slices):
        return ok(doc_id)
    engine.rollback(doc_id)
    return jsonify({"error": "裁切失敗"}), 500


@app.route("/api/crop/preview", methods=["POST"])
def crop_preview():
    """預覽裁切結果"""
    data = request.json
    doc_id = data.get("doc_id")
    page_num = data.get("page_num")
    cut_lines = data.get("cut_lines", [])  # list of y-coordinates

    if not all([doc_id, page_num is not None]):
        return jsonify({"error": "缺少必要參數"}), 400

    page_info = engine.get_page_info(doc_id, page_num)
    if not page_info:
        return jsonify({"error": "頁面不存在"}), 404

    # 根據切割線計算切片
    height = page_info["height"]
    sorted_lines = sorted(cut_lines)

    slices = []
    prev = 0
    for line_y in sorted_lines:
        if line_y > prev:
            slices.append({"top": prev, "bottom": line_y, "index": len(slices)})
        prev = line_y
    if prev < height:
        slices.append({"top": prev, "bottom": height, "index": len(slices)})

    return jsonify({"slices": slices, "page_height": height})


# ========================
# 合併
# ========================

@app.route("/api/merge", methods=["POST"])
def merge_pdfs():
    """合併多個 PDF"""
    # 支援上傳新檔案 + 已載入文件的混合合併
    doc_ids_and_pages = []

    # 處理已載入的文件
    merge_config = request.form.get("config")
    if merge_config:
        config = json.loads(merge_config)
        doc_ids_and_pages = config

    # 處理新上傳的檔案
    files = request.files.getlist("files")
    for f in files:
        if f.filename and f.filename.lower().endswith(".pdf"):
            try:
                doc_id, _ = engine.load_pdf(f, f.filename)
            except PasswordRequired:
                return jsonify({"error": f"「{f.filename}」有密碼保護，請先在清單中開啟它"}), 400
            doc_ids_and_pages.append({"doc_id": doc_id, "pages": None})

    if not doc_ids_and_pages:
        return jsonify({"error": "未提供任何 PDF"}), 400

    merged_bytes = engine.merge_pdfs(doc_ids_and_pages)
    if not merged_bytes:
        return jsonify({"error": "合併失敗"}), 500

    return send_file(
        io.BytesIO(merged_bytes),
        mimetype="application/pdf",
        as_attachment=True,
        download_name="merged.pdf",
    )


# ========================
# 匯出
# ========================

@app.route("/api/export/pdf/<doc_id>")
def export_pdf(doc_id):
    """匯出 PDF；原檔有密碼時，keep_password=0 表示匯出不要密碼"""
    keep_password = request.args.get("keep_password", "1") != "0"
    pdf_bytes = engine.export_pdf(doc_id, keep_password=keep_password)
    if not pdf_bytes:
        return jsonify({"error": "文件不存在"}), 404

    info = engine.documents.get(doc_id, {})
    filename = info.get("filename", "output.pdf")
    name, _ = os.path.splitext(filename)
    download_name = f"{name}_edited.pdf"

    return send_file(
        io.BytesIO(pdf_bytes),
        mimetype="application/pdf",
        as_attachment=True,
        download_name=download_name,
    )


@app.route("/api/export/jpg/<doc_id>")
def export_jpg(doc_id):
    """匯出所有頁面為 JPG（ZIP 打包）"""
    quality = int(request.args.get("quality", 90))
    jpg_list = engine.export_all_pages_as_jpg(doc_id, quality=quality)
    if not jpg_list:
        return jsonify({"error": "匯出失敗"}), 500

    # 打包為 ZIP
    zip_buf = io.BytesIO()
    with zipfile.ZipFile(zip_buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for i, jpg_bytes in enumerate(jpg_list):
            zf.writestr(f"page_{i + 1:03d}.jpg", jpg_bytes)

    zip_buf.seek(0)
    info = engine.documents.get(doc_id, {})
    filename = info.get("filename", "output")
    name, _ = os.path.splitext(filename)

    return send_file(
        zip_buf,
        mimetype="application/zip",
        as_attachment=True,
        download_name=f"{name}_images.zip",
    )


@app.route("/api/export/jpg/<doc_id>/<int:page_num>")
def export_single_jpg(doc_id, page_num):
    """匯出單頁為 JPG"""
    quality = int(request.args.get("quality", 90))
    jpg_bytes = engine.export_page_as_jpg(doc_id, page_num, quality=quality)
    if not jpg_bytes:
        return jsonify({"error": "匯出失敗"}), 500

    return send_file(
        io.BytesIO(jpg_bytes),
        mimetype="image/jpeg",
        as_attachment=True,
        download_name=f"page_{page_num + 1}.jpg",
    )


@app.route("/api/export/docx/<doc_id>")
def export_docx(doc_id):
    """匯出為 Word 文件"""
    doc = engine.get_doc(doc_id)
    if not doc:
        return jsonify({"error": "文件不存在"}), 404

    try:
        from pdf2docx import Converter

        info = engine.documents.get(doc_id, {})
        docx_buf = io.BytesIO()
        with tempfile.TemporaryDirectory() as tmp:
            temp_pdf = os.path.join(tmp, "in.pdf")
            temp_docx = os.path.join(tmp, "out.docx")
            with open(temp_pdf, "wb") as f:
                f.write(doc.tobytes(garbage=3, deflate=True))

            cv = Converter(temp_pdf)
            cv.convert(temp_docx)
            cv.close()

            with open(temp_docx, "rb") as f:
                docx_buf.write(f.read())

        docx_buf.seek(0)
        filename = info.get("filename", "output.pdf")
        name, _ = os.path.splitext(filename)

        return send_file(
            docx_buf,
            mimetype="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            as_attachment=True,
            download_name=f"{name}.docx",
        )
    except ImportError:
        return jsonify({"error": "pdf2docx 未安裝"}), 500
    except Exception as e:
        return jsonify({"error": f"轉換失敗: {str(e)}"}), 500


# ========================
# 清理
# ========================

@app.route("/api/close/<doc_id>", methods=["POST"])
def close_doc(doc_id):
    """關閉並清理文件"""
    engine.cleanup(doc_id)
    return jsonify({"success": True})


# ========================
# 啟動
# ========================

if __name__ == "__main__":
    import sys
    import threading
    import webbrowser

    print("=" * 50)
    print("  PDF 編輯器啟動中...")
    print("  開啟瀏覽器訪問: http://localhost:5000")
    print("  關閉這個視窗就會結束程式")
    print("=" * 50)
    if "--open" in sys.argv:
        threading.Timer(1.5, lambda: webbrowser.open("http://localhost:5000")).start()
    app.run(host="127.0.0.1", port=5000, debug=False)
