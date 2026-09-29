"""
PDF 處理引擎 — 核心邏輯
使用 PyMuPDF (fitz) 處理所有 PDF 操作
"""
import fitz  # PyMuPDF
import os
import io
import uuid
import shutil
from PIL import Image, ImageOps
from fontTools import subset as ft_subset
from fontTools.ttLib import TTFont, newTable
from fontTools.pens.cu2quPen import Cu2QuPen
from fontTools.pens.ttGlyphPen import TTGlyphPen

# 每份文件最多保留幾步可以「上一步」
MAX_HISTORY = 50


class PasswordRequired(Exception):
    """PDF 有開啟密碼，而且沒給或給錯"""

    def __init__(self, wrong):
        super().__init__("wrong password" if wrong else "password required")
        self.wrong = wrong


class PDFEngine:
    """PDF 處理引擎，封裝所有 PDF 操作"""

    def __init__(self, upload_dir="uploads", font_dir="fonts"):
        self.font_dir = font_dir
        # {doc_id: {"filename", "doc", "undo": [bytes], "redo": [bytes], "password"}}
        # 文件只放在記憶體，不寫進磁碟（常有存摺、保單這類個資文件）
        self.documents = {}
        self._font_bytes = None
        # 舊版會把每個開過的檔案複製一份到 uploads/，而且程式被直接關掉時不會清。這裡順手清掉
        if os.path.isdir(upload_dir):
            shutil.rmtree(upload_dir, ignore_errors=True)

    # ========================
    # 字型
    # ========================

    def _get_font_path(self):
        """取得中文字型路徑"""
        for name in ("NotoSansTC-Regular.otf", "NotoSansTC-Regular.ttf"):
            font_path = os.path.join(self.font_dir, name)
            if os.path.exists(font_path):
                return font_path
        return None

    @staticmethod
    def _cff_to_truetype(font):
        """
        把 CFF 字形轉成 TrueType 字形。
        思源黑體是 CID 字型，抽出部分字後字形編號會重排，
        PDF 閱讀器仍照舊編號找字形，結果「文字抓得到、畫面卻一片空白」；
        轉成 TrueType 後編號與字形一一對應，就不會有這個問題。
        """
        order = font.getGlyphOrder()
        glyph_set = font.getGlyphSet()
        glyf = newTable("glyf")
        glyf.glyphOrder = order
        glyf.glyphs = {}
        for name in order:
            pen = TTGlyphPen(glyph_set)
            glyph_set[name].draw(Cu2QuPen(pen, 1.0, reverse_direction=True))
            glyf.glyphs[name] = pen.glyph()
        font["loca"] = newTable("loca")
        font["glyf"] = glyf
        del font["CFF "]
        if "VORG" in font:
            del font["VORG"]
        maxp = newTable("maxp")
        maxp.tableVersion = 0x00010000
        for key in ("maxTwilightPoints", "maxStorage", "maxFunctionDefs", "maxInstructionDefs",
                    "maxStackElements", "maxSizeOfInstructions", "maxComponentElements"):
            setattr(maxp, key, 0)
        maxp.maxZones = 1
        font["maxp"] = maxp
        font["head"].glyphDataFormat = 0
        font["post"].formatType = 3.0
        font.sfntVersion = "\x00\x01\x00\x00"

    def _font_for_text(self, text):
        """
        只取出 text 用到的字做成小字型再嵌入（每段約數 KB）。
        整套中文字型 16MB，直接嵌入會讓每份匯出的 PDF 都變成 17MB 以上。
        """
        font_path = self._get_font_path()
        if not font_path:
            return fitz.Font("helv")
        if self._font_bytes is None:
            with open(font_path, "rb") as f:
                self._font_bytes = f.read()

        font = TTFont(io.BytesIO(self._font_bytes))
        options = ft_subset.Options()
        options.layout_features = []
        options.name_IDs = ["*"]
        options.notdef_outline = True
        subsetter = ft_subset.Subsetter(options)
        subsetter.populate(text=text)
        subsetter.subset(font)
        if "CFF " in font:
            self._cff_to_truetype(font)
        buf = io.BytesIO()
        font.save(buf)
        return fitz.Font(fontbuffer=buf.getvalue())

    # ========================
    # 文件管理
    # ========================

    def load_pdf(self, file_stream, filename, password=None):
        """
        載入 PDF 檔案，返回 doc_id。
        有開啟密碼的檔案：解鎖後轉成沒加密的工作副本來編輯
        （直接在加密檔上改，匯出時原內容會壞掉），匯出時再用同一組密碼上鎖。
        """
        filename = os.path.basename(filename.replace("\\", "/")) or "document.pdf"
        doc = fitz.open("pdf", file_stream.read())

        locked_with = None
        if doc.needs_pass:
            if not password or not doc.authenticate(password):
                doc.close()
                raise PasswordRequired(wrong=bool(password))
            locked_with = password
        if locked_with or doc.is_encrypted:
            plain = doc.tobytes(encryption=fitz.PDF_ENCRYPT_NONE)
            doc.close()
            doc = fitz.open("pdf", plain)

        if doc.page_count == 0:
            doc.close()
            raise ValueError("這個檔案沒有任何頁面")

        doc_id = str(uuid.uuid4())[:8]
        self.documents[doc_id] = {
            "filename": filename,
            "doc": doc,
            "undo": [],
            "redo": [],
            "password": locked_with,
        }
        return doc_id, doc.page_count

    def is_locked(self, doc_id):
        info = self.documents.get(doc_id)
        return bool(info and info.get("password"))

    def get_doc(self, doc_id):
        """取得文件物件"""
        info = self.documents.get(doc_id)
        if not info:
            return None
        return info["doc"]

    def get_page_count(self, doc_id):
        """取得頁數"""
        doc = self.get_doc(doc_id)
        if doc:
            return doc.page_count
        return 0

    def _get_page(self, doc_id, page_num):
        doc = self.get_doc(doc_id)
        if not doc or page_num is None or page_num < 0 or page_num >= doc.page_count:
            return None
        return doc[page_num]

    # ========================
    # 上一步／下一步（整份快照）
    # ========================

    def snapshot(self, doc_id):
        """在修改文件之前呼叫：把目前狀態存起來，供「上一步」還原"""
        info = self.documents.get(doc_id)
        if not info:
            return
        info["undo"].append(info["doc"].tobytes())
        if len(info["undo"]) > MAX_HISTORY:
            info["undo"].pop(0)
        info["redo"].clear()

    def _replace_doc(self, info, pdf_bytes):
        info["doc"].close()
        info["doc"] = fitz.open("pdf", pdf_bytes)

    def undo(self, doc_id):
        info = self.documents.get(doc_id)
        if not info or not info["undo"]:
            return False
        info["redo"].append(info["doc"].tobytes())
        self._replace_doc(info, info["undo"].pop())
        return True

    def redo(self, doc_id):
        info = self.documents.get(doc_id)
        if not info or not info["redo"]:
            return False
        info["undo"].append(info["doc"].tobytes())
        self._replace_doc(info, info["redo"].pop())
        return True

    def rollback(self, doc_id):
        """修改失敗時退回剛存的快照（不留下「下一步」）"""
        info = self.documents.get(doc_id)
        if info and info["undo"]:
            self._replace_doc(info, info["undo"].pop())

    def history_state(self, doc_id):
        info = self.documents.get(doc_id)
        if not info:
            return {"can_undo": False, "can_redo": False, "page_count": 0}
        return {
            "can_undo": bool(info["undo"]),
            "can_redo": bool(info["redo"]),
            "page_count": info["doc"].page_count,
        }

    # ========================
    # 渲染
    # ========================

    def render_page(self, doc_id, page_num, zoom=2.0):
        """渲染頁面為 PNG 圖片"""
        page = self._get_page(doc_id, page_num)
        if not page:
            return None

        mat = fitz.Matrix(zoom, zoom)
        pix = page.get_pixmap(matrix=mat, alpha=False)

        img_bytes = pix.tobytes("png")
        return img_bytes, pix.width, pix.height

    def render_thumbnail(self, doc_id, page_num, width=200):
        """渲染頁面縮圖"""
        page = self._get_page(doc_id, page_num)
        if not page:
            return None

        # 計算縮放比例使寬度為指定值
        zoom = width / page.rect.width
        mat = fitz.Matrix(zoom, zoom)
        pix = page.get_pixmap(matrix=mat, alpha=False)

        return pix.tobytes("png")

    # ========================
    # 文字
    # ========================

    def get_page_text_blocks(self, doc_id, page_num):
        """提取頁面文字及座標（text spans）"""
        page = self._get_page(doc_id, page_num)
        if not page:
            return None

        blocks = page.get_text("dict", flags=fitz.TEXT_PRESERVE_WHITESPACE)

        text_items = []
        for block in blocks.get("blocks", []):
            if block.get("type") == 0:  # text block
                for line in block.get("lines", []):
                    for span in line.get("spans", []):
                        text_items.append({
                            "text": span["text"],
                            "bbox": list(span["bbox"]),
                            "size": span["size"],
                            "font": span["font"],
                            "color": span["color"],
                            "origin": list(span["origin"]),
                        })
        return text_items, page.rect.width, page.rect.height

    def delete_text_in_rects(self, doc_id, page_num, rects):
        """
        刪除指定區域內的文字。
        只拿掉文字本身：不補白底、不動表格線與圖片。
        區域上下各內縮兩成，避免誤刪上下行貼得很近的字。
        """
        page = self._get_page(doc_id, page_num)
        if not page:
            return False

        for rect in rects:
            r = fitz.Rect(rect)
            dy = r.height * 0.2
            dx = min(0.5, r.width * 0.1)
            r = fitz.Rect(r.x0 + dx, r.y0 + dy, r.x1 - dx, r.y1 - dy)
            if r.is_empty:
                continue
            page.add_redact_annot(r, fill=False)

        page.apply_redactions(
            images=fitz.PDF_REDACT_IMAGE_NONE,
            graphics=fitz.PDF_REDACT_LINE_ART_NONE,
        )
        return True

    @staticmethod
    def _to_rgb(color):
        """前端傳 0–255 的 [r,g,b]；PDF 內部的 span 顏色是 0xRRGGBB 整數"""
        if isinstance(color, int):
            return ((color >> 16) & 255) / 255.0, ((color >> 8) & 255) / 255.0, (color & 255) / 255.0
        if isinstance(color, (list, tuple)) and len(color) == 3:
            return tuple(max(0, min(255, c)) / 255.0 for c in color)
        return 0, 0, 0

    def add_text(self, doc_id, page_num, x, y, text, font_size=12, color=(0, 0, 0), anchor="top"):
        """
        在指定位置新增文字（可多行）。
        anchor="top"：(x, y) 是第一行文字框的左上角，與畫面上的輸入框對齊。
        anchor="baseline"：(x, y) 是第一行的基線（沿用原文字位置時使用）。
        行高＝字型的上緣＋下緣，與前端輸入框的 line-height 相同。
        """
        page = self._get_page(doc_id, page_num)
        if not page:
            return False

        lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
        font = self._font_for_text("".join(lines) or " ")
        ascender = font.ascender or 1.16
        descender = font.descender or -0.288
        line_height = (ascender - descender) * font_size

        baseline = y + ascender * font_size if anchor == "top" else y

        tw = fitz.TextWriter(page.rect)
        for i, line in enumerate(lines):
            if line:
                tw.append((x, baseline + i * line_height), line, font=font, fontsize=font_size)
        tw.write_text(page, color=self._to_rgb(color))
        return True

    def replace_text(self, doc_id, page_num, rects, x, baseline, text, font_size, color):
        """刪除原文字後，在原本的基線位置寫入新文字"""
        if not self.delete_text_in_rects(doc_id, page_num, rects):
            return False
        return self.add_text(doc_id, page_num, x, baseline, text, font_size, color, anchor="baseline")

    # ========================
    # 圖片
    # ========================

    @staticmethod
    def _normalize_image(img_bytes):
        """
        手機照片常靠 EXIF 標記方向，瀏覽器會自動轉正、PDF 不會，放進去就會躺著。
        這裡先把方向轉正；PDF 不支援的格式（WebP、GIF…）轉成 PNG。其餘原檔直接用，不重新壓縮。
        """
        try:
            img = Image.open(io.BytesIO(img_bytes))
            fmt = img.format
            orientation = img.getexif().get(0x0112, 1)
        except Exception:
            return img_bytes

        if orientation == 1 and fmt in ("JPEG", "PNG"):
            return img_bytes

        img = ImageOps.exif_transpose(img)
        buf = io.BytesIO()
        if fmt == "JPEG" and img.mode in ("RGB", "L", "CMYK"):
            img.save(buf, format="JPEG", quality=95)
        else:
            if img.mode not in ("RGB", "RGBA", "L", "LA"):
                img = img.convert("RGBA")
            img.save(buf, format="PNG")
        return buf.getvalue()

    def add_image(self, doc_id, page_num, img_bytes, rect, rotate=0):
        """
        在指定位置嵌入圖片。
        rect 是畫面上圖片（含旋轉後）的外框；rotate 為畫面上順時針旋轉的角度（90 的倍數）。
        """
        page = self._get_page(doc_id, page_num)
        if not page:
            return False

        page.insert_image(
            fitz.Rect(rect),
            stream=self._normalize_image(img_bytes),
            keep_proportion=False,
            # PyMuPDF 的 rotate 是逆時針
            rotate=(360 - int(rotate)) % 360,
        )
        return True

    # ========================
    # 頁面
    # ========================

    def apply_crop(self, doc_id, page_num, slices_to_keep):
        """
        應用裁切：將頁面按切片重建
        slices_to_keep: list of {"top": float, "bottom": float} (PDF 座標)
        """
        page = self._get_page(doc_id, page_num)
        if not page:
            return False
        doc = self.get_doc(doc_id)
        original_rect = page.rect

        # 建立臨時文件
        temp_doc = fitz.open()

        for slice_info in slices_to_keep:
            top = max(original_rect.y0, float(slice_info["top"]))
            bottom = min(original_rect.y1, float(slice_info["bottom"]))
            if bottom - top < 1:
                continue
            clip_rect = fitz.Rect(original_rect.x0, top, original_rect.x1, bottom)
            slice_height = bottom - top
            # 新頁面大小為切片大小
            new_page = temp_doc.new_page(width=original_rect.width, height=slice_height)
            # 將原頁面的切片區域複製到新頁面
            new_page.show_pdf_page(
                fitz.Rect(0, 0, original_rect.width, slice_height),
                doc,
                page_num,
                clip=clip_rect,
            )

        if temp_doc.page_count == 0:
            temp_doc.close()
            return False

        # 替換原頁面
        doc.delete_page(page_num)
        doc.insert_pdf(temp_doc, start_at=page_num)

        temp_doc.close()
        return True

    def merge_pdfs(self, doc_ids_and_pages):
        """
        合併多個 PDF
        doc_ids_and_pages: list of {"doc_id": str, "pages": list[int] or None}
        pages=None 表示包含所有頁面
        返回合併後的 bytes
        """
        merged = fitz.open()

        for item in doc_ids_and_pages:
            doc = self.get_doc(item["doc_id"])
            if not doc:
                continue
            pages = item.get("pages")

            if pages is None:
                merged.insert_pdf(doc)
            else:
                for page_num in pages:
                    if 0 <= page_num < doc.page_count:
                        merged.insert_pdf(doc, from_page=page_num, to_page=page_num)

        if merged.page_count == 0:
            merged.close()
            return None
        output = merged.tobytes(garbage=3, deflate=True)
        merged.close()
        return output

    def delete_pages(self, doc_id, page_numbers):
        """刪除指定頁面"""
        doc = self.get_doc(doc_id)
        if not doc:
            return False

        # 從後往前刪除以避免索引偏移
        for page_num in sorted(set(page_numbers), reverse=True):
            if 0 <= page_num < doc.page_count:
                doc.delete_page(page_num)
        return True

    # ========================
    # 匯出
    # ========================

    def export_pdf(self, doc_id, keep_password=True):
        """
        匯出 PDF bytes（清掉被刪除內容留下的殘骸並壓縮）。
        原檔有開啟密碼的：keep_password=True 用同一組密碼重新上鎖，False 則匯出沒有密碼的檔案。
        """
        info = self.documents.get(doc_id)
        if not info:
            return None
        if info.get("password") and keep_password:
            return info["doc"].tobytes(
                garbage=3, deflate=True,
                encryption=fitz.PDF_ENCRYPT_AES_256,
                user_pw=info["password"], owner_pw=info["password"],
            )
        return info["doc"].tobytes(garbage=3, deflate=True)

    def export_page_as_jpg(self, doc_id, page_num, quality=90, zoom=2.0):
        """匯出單頁為 JPG"""
        page = self._get_page(doc_id, page_num)
        if not page:
            return None

        mat = fitz.Matrix(zoom, zoom)
        pix = page.get_pixmap(matrix=mat, alpha=False)

        # 轉換為 JPG
        img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=quality)
        return buf.getvalue()

    def export_all_pages_as_jpg(self, doc_id, quality=90, zoom=2.0):
        """匯出所有頁面為 JPG，返回 list of bytes"""
        doc = self.get_doc(doc_id)
        if not doc:
            return []

        results = []
        for i in range(doc.page_count):
            jpg_bytes = self.export_page_as_jpg(doc_id, i, quality, zoom)
            if jpg_bytes:
                results.append(jpg_bytes)
        return results

    def get_page_info(self, doc_id, page_num):
        """取得頁面資訊"""
        page = self._get_page(doc_id, page_num)
        if not page:
            return None

        return {
            "width": page.rect.width,
            "height": page.rect.height,
            "rotation": page.rotation,
        }

    # ========================
    # 清理
    # ========================

    def cleanup(self, doc_id):
        """清理文件資源"""
        info = self.documents.pop(doc_id, None)
        if info:
            info["doc"].close()

    def cleanup_all(self):
        """清理所有資源"""
        for doc_id in list(self.documents.keys()):
            self.cleanup(doc_id)
