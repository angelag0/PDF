"""
PDF 處理引擎 — 核心邏輯
使用 PyMuPDF (fitz) 處理所有 PDF 操作
"""
import fitz  # PyMuPDF
import os
import io
import uuid
import shutil
from PIL import Image


class PDFEngine:
    """PDF 處理引擎，封裝所有 PDF 操作"""

    def __init__(self, upload_dir="uploads", font_dir="fonts"):
        self.upload_dir = upload_dir
        self.font_dir = font_dir
        self.documents = {}  # {doc_id: {"path": str, "doc": fitz.Document}}
        os.makedirs(upload_dir, exist_ok=True)

    def _get_font_path(self):
        """取得中文字型路徑"""
        font_path = os.path.join(self.font_dir, "NotoSansTC-Regular.otf")
        if os.path.exists(font_path):
            return font_path
        # Fallback: try ttf
        font_path_ttf = os.path.join(self.font_dir, "NotoSansTC-Regular.ttf")
        if os.path.exists(font_path_ttf):
            return font_path_ttf
        return None

    def load_pdf(self, file_stream, filename):
        """載入 PDF 檔案，返回 doc_id"""
        doc_id = str(uuid.uuid4())[:8]
        save_dir = os.path.join(self.upload_dir, doc_id)
        os.makedirs(save_dir, exist_ok=True)
        save_path = os.path.join(save_dir, filename)
        file_stream.save(save_path)

        doc = fitz.open(save_path)
        self.documents[doc_id] = {
            "path": save_path,
            "filename": filename,
            "doc": doc,
        }
        return doc_id, doc.page_count

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

    def render_page(self, doc_id, page_num, zoom=2.0):
        """渲染頁面為 PNG 圖片"""
        doc = self.get_doc(doc_id)
        if not doc or page_num < 0 or page_num >= doc.page_count:
            return None

        page = doc[page_num]
        mat = fitz.Matrix(zoom, zoom)
        pix = page.get_pixmap(matrix=mat, alpha=False)

        img_bytes = pix.tobytes("png")
        return img_bytes, pix.width, pix.height

    def render_thumbnail(self, doc_id, page_num, width=200):
        """渲染頁面縮圖"""
        doc = self.get_doc(doc_id)
        if not doc or page_num < 0 or page_num >= doc.page_count:
            return None

        page = doc[page_num]
        # 計算縮放比例使寬度為指定值
        page_width = page.rect.width
        zoom = width / page_width
        mat = fitz.Matrix(zoom, zoom)
        pix = page.get_pixmap(matrix=mat, alpha=False)

        img_bytes = pix.tobytes("png")
        return img_bytes

    def get_page_text_blocks(self, doc_id, page_num):
        """提取頁面文字及座標（text blocks）"""
        doc = self.get_doc(doc_id)
        if not doc or page_num < 0 or page_num >= doc.page_count:
            return []

        page = doc[page_num]
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

    def delete_text_in_rect(self, doc_id, page_num, rect):
        """刪除指定區域內的文字"""
        doc = self.get_doc(doc_id)
        if not doc or page_num < 0 or page_num >= doc.page_count:
            return False

        page = doc[page_num]
        target_rect = fitz.Rect(rect)

        # 用白色矩形覆蓋文字區域（redaction）
        page.add_redact_annot(target_rect)
        page.apply_redactions()
        return True

    def add_text(self, doc_id, page_num, x, y, text, font_size=12, color=(0, 0, 0)):
        """在指定位置新增文字"""
        doc = self.get_doc(doc_id)
        if not doc or page_num < 0 or page_num >= doc.page_count:
            return False

        page = doc[page_num]
        font_path = self._get_font_path()

        # 準備顏色（RGB 0-1 範圍）
        if isinstance(color, (list, tuple)) and len(color) == 3:
            r, g, b = [c / 255.0 if c > 1 else c for c in color]
        else:
            r, g, b = 0, 0, 0

        # 使用 TextWriter 支援中文
        tw = fitz.TextWriter(page.rect)
        if font_path:
            font = fitz.Font(fontfile=font_path)
        else:
            font = fitz.Font("helv")

        tw.append((x, y), text, font=font, fontsize=font_size)
        tw.write_text(page, color=(r, g, b))

        return True

    def add_image(self, doc_id, page_num, img_bytes, rect):
        """在指定位置嵌入圖片"""
        doc = self.get_doc(doc_id)
        if not doc or page_num < 0 or page_num >= doc.page_count:
            return False

        page = doc[page_num]
        target_rect = fitz.Rect(rect)

        page.insert_image(target_rect, stream=img_bytes)
        return True

    def crop_page(self, doc_id, page_num, slices_to_keep):
        """
        裁切頁面：根據水平切割線分割，保留指定切片
        slices_to_keep: list of {"top": float, "bottom": float} (PDF 座標)
        返回新的頁面列表
        """
        doc = self.get_doc(doc_id)
        if not doc or page_num < 0 or page_num >= doc.page_count:
            return False

        page = doc[page_num]
        original_rect = page.rect

        # 建立新文件來存放切片結果
        new_pages_data = []
        for slice_info in slices_to_keep:
            top = slice_info["top"]
            bottom = slice_info["bottom"]
            clip_rect = fitz.Rect(
                original_rect.x0, top,
                original_rect.x1, bottom
            )
            new_pages_data.append(clip_rect)

        return new_pages_data

    def apply_crop(self, doc_id, page_num, slices_to_keep):
        """
        應用裁切：將頁面按切片重建
        """
        doc = self.get_doc(doc_id)
        if not doc or page_num < 0 or page_num >= doc.page_count:
            return False

        page = doc[page_num]
        original_rect = page.rect

        # 建立臨時文件
        temp_doc = fitz.open()

        for slice_info in slices_to_keep:
            top = slice_info["top"]
            bottom = slice_info["bottom"]
            clip_rect = fitz.Rect(
                original_rect.x0, top,
                original_rect.x1, bottom
            )
            slice_height = bottom - top
            # 新頁面大小為切片大小
            new_page = temp_doc.new_page(
                width=original_rect.width,
                height=slice_height
            )
            # 將原頁面的切片區域複製到新頁面
            new_page.show_pdf_page(
                fitz.Rect(0, 0, original_rect.width, slice_height),
                doc,
                page_num,
                clip=clip_rect
            )

        # 替換原頁面
        # 先刪除原頁面
        doc.delete_page(page_num)
        # 插入新頁面
        for i in range(temp_doc.page_count):
            doc.insert_pdf(temp_doc, from_page=i, to_page=i, start_at=page_num + i)

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
            doc_id = item["doc_id"]
            pages = item.get("pages")
            doc = self.get_doc(doc_id)
            if not doc:
                continue

            if pages is None:
                merged.insert_pdf(doc)
            else:
                for page_num in pages:
                    if 0 <= page_num < doc.page_count:
                        merged.insert_pdf(doc, from_page=page_num, to_page=page_num)

        output = merged.tobytes()
        merged.close()
        return output

    def delete_pages(self, doc_id, page_numbers):
        """刪除指定頁面"""
        doc = self.get_doc(doc_id)
        if not doc:
            return False

        # 從後往前刪除以避免索引偏移
        for page_num in sorted(page_numbers, reverse=True):
            if 0 <= page_num < doc.page_count:
                doc.delete_page(page_num)
        return True

    def export_pdf(self, doc_id):
        """匯出 PDF bytes"""
        doc = self.get_doc(doc_id)
        if not doc:
            return None
        return doc.tobytes()

    def export_page_as_jpg(self, doc_id, page_num, quality=90, zoom=2.0):
        """匯出單頁為 JPG"""
        doc = self.get_doc(doc_id)
        if not doc or page_num < 0 or page_num >= doc.page_count:
            return None

        page = doc[page_num]
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
        doc = self.get_doc(doc_id)
        if not doc or page_num < 0 or page_num >= doc.page_count:
            return None

        page = doc[page_num]
        return {
            "width": page.rect.width,
            "height": page.rect.height,
            "rotation": page.rotation,
        }

    def cleanup(self, doc_id):
        """清理文件資源"""
        info = self.documents.pop(doc_id, None)
        if info:
            info["doc"].close()
            save_dir = os.path.join(self.upload_dir, doc_id)
            if os.path.exists(save_dir):
                shutil.rmtree(save_dir)

    def cleanup_all(self):
        """清理所有資源"""
        for doc_id in list(self.documents.keys()):
            self.cleanup(doc_id)
