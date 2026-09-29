/**
 * 文字編輯器模組
 * 處理文字選取、複製、刪除、修改、新增文字
 *
 * 新增文字採「所見即所得」：輸入框用跟 PDF 相同的字型檔、字級與行高，
 * 框的左上角就是文字寫進 PDF 的位置（後端 add_text 的 anchor="top"）。
 */

// 與後端相同的字型度量（Noto Sans TC：上緣 1.16、下緣 0.288，單位為字級）
const TEXT_ASCENT = 1.16;
const TEXT_LINE_HEIGHT = 1.448;

class TextEditor {
    constructor() {
        this.textOverlay = document.getElementById('text-overlay');
        this.selectionRect = document.getElementById('selection-rect');
        this.selectedTextPreview = document.getElementById('selected-text-preview');

        this.textItems = [];
        this.selectedSpans = [];
        this.isSelecting = false;
        this.selectionStart = null;

        // 文字輸入模式
        this.isTextInputMode = false;
        // 目前正在打、還沒放進 PDF 的文字框：{box, ta, pageNum, x, y}（x, y 為 PDF 座標）
        this.pending = null;

        this._bindEvents();
    }

    _bindEvents() {
        // 選取框拖拽
        this.textOverlay.addEventListener('mousedown', (e) => this._onMouseDown(e));
        document.addEventListener('mousemove', (e) => this._onMouseMove(e));
        document.addEventListener('mouseup', (e) => this._onMouseUp(e));

        // 打字模式：點頁面放文字
        this.textOverlay.addEventListener('click', (e) => this._onTypingClick(e));

        // 右鍵選單
        this.textOverlay.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            if (this.selectedSpans.length > 0) {
                this._showContextMenu(e.clientX, e.clientY);
            }
        });

        // 字級、顏色改變時，正在打的字即時跟著變
        document.getElementById('font-size-input').addEventListener('input', () => this._layoutPending());
        document.getElementById('font-color-input').addEventListener('input', () => this._layoutPending());
        document.getElementById('font-color-hex').addEventListener('change', () => this._layoutPending());
    }

    /**
     * 載入頁面文字座標
     */
    async loadTextBlocks(docId, pageNum) {
        try {
            const resp = await fetch(`/api/page/${docId}/${pageNum}/text`);
            const data = await readJSON(resp);
            if (data.error) return;

            this.textItems = data.text_items || [];
            this.selectedSpans = [];
            this._renderTextOverlay();
            this._updateSelectionUI();
        } catch (e) {
            console.error('Failed to load text blocks:', e);
        }
    }

    /**
     * 渲染文字覆蓋層
     */
    _renderTextOverlay() {
        // 清除舊的覆蓋層
        this.textOverlay.querySelectorAll('.text-span-overlay').forEach(el => el.remove());

        const viewer = window.pdfViewer;
        if (!viewer) return;

        this.textItems.forEach((item, index) => {
            if (!item.text.trim()) return;

            const screenPos0 = viewer.pdfToScreen(item.bbox[0], item.bbox[1]);
            const screenPos1 = viewer.pdfToScreen(item.bbox[2], item.bbox[3]);

            const span = document.createElement('div');
            span.className = 'text-span-overlay';
            if (this.selectedSpans.includes(index)) span.classList.add('selected');
            span.dataset.index = index;
            span.style.left = screenPos0.x + 'px';
            span.style.top = screenPos0.y + 'px';
            span.style.width = (screenPos1.x - screenPos0.x) + 'px';
            span.style.height = (screenPos1.y - screenPos0.y) + 'px';
            span.title = item.text;

            span.addEventListener('click', (e) => {
                if (this.isTextInputMode) return;
                e.stopPropagation();
                if (e.ctrlKey || e.metaKey) {
                    // 多選
                    this._toggleSpan(span, index);
                } else {
                    // 單選
                    this._clearSelection();
                    this._selectSpan(span, index);
                }
            });

            // 插在最前面，讓正在打字的輸入框永遠在上層
            this.textOverlay.insertBefore(span, this.textOverlay.firstChild);
        });
    }

    /**
     * 啟用選取模式
     */
    enableSelectMode() {
        this.isTextInputMode = false;
        this.textOverlay.classList.add('selecting');
        this.textOverlay.classList.remove('typing');
    }

    /**
     * 啟用文字輸入模式
     */
    enableTextInputMode() {
        this.isTextInputMode = true;
        this.textOverlay.classList.add('selecting', 'typing');
        this._clearSelection();
    }

    /**
     * 停用所有模式（呼叫前應先 commitPending）
     */
    disable() {
        this.isTextInputMode = false;
        this.textOverlay.classList.remove('selecting', 'typing');
        this.cancelPendingInput();
    }

    // ---- 新增文字 ----

    async _onTypingClick(e) {
        if (!this.isTextInputMode || !window.pdfViewer.docId) return;
        if (this.pending && this.pending.box.contains(e.target)) return;

        const viewer = window.pdfViewer;
        const rect = this.textOverlay.getBoundingClientRect();
        const pdf = viewer.screenToPDF(e.clientX - rect.left, e.clientY - rect.top);

        // 已經打好的上一段先放進 PDF，再在新位置開一個框（連續填表格不用每次按確認）
        const ok = await this.commitPending();
        if (!ok) return;

        // 讓點下去的位置落在第一行文字的垂直中央
        const size = this._fontSize();
        this._createTextInput(pdf.x, pdf.y - (size * TEXT_LINE_HEIGHT) / 2);
    }

    _fontSize() {
        const v = parseFloat(document.getElementById('font-size-input').value);
        return Math.max(4, Math.min(200, isNaN(v) ? 14 : v));
    }

    _fontColor() {
        return document.getElementById('font-color-input').value || '#000000';
    }

    /**
     * 建立文字輸入框（x, y 為第一行文字框左上角的 PDF 座標）
     */
    _createTextInput(x, y) {
        this.cancelPendingInput();
        const viewer = window.pdfViewer;

        const box = document.createElement('div');
        box.className = 'text-input-box';

        const handle = document.createElement('div');
        handle.className = 'text-input-handle';
        handle.title = '按住拖曳可移動位置';
        handle.textContent = '⠿';

        const ta = document.createElement('textarea');
        ta.className = 'text-input-area';
        ta.setAttribute('wrap', 'off');
        ta.spellcheck = false;
        ta.placeholder = '在這裡打字';

        box.appendChild(handle);
        box.appendChild(ta);
        this.textOverlay.appendChild(box);

        // 框內的點擊不要被當成「在頁面上點新位置」或「開始框選」
        box.addEventListener('mousedown', (e) => e.stopPropagation());
        box.addEventListener('click', (e) => e.stopPropagation());

        ta.addEventListener('input', () => this._autosize());
        ta.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                this.commitPending();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                this.cancelPendingInput();
            }
        });

        // 拖曳把手移動位置
        handle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const startX = e.clientX;
            const startY = e.clientY;
            const orig = { x: this.pending.x, y: this.pending.y };
            const ratio = viewer.getScreenToPDFRatio();
            const onMove = (e2) => {
                if (!this.pending) return;
                this.pending.x = orig.x + (e2.clientX - startX) * ratio.x;
                this.pending.y = orig.y + (e2.clientY - startY) * ratio.y;
                this._layoutPending();
            };
            const onUp = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                this.pending?.ta.focus();
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });

        this.pending = { box, ta, pageNum: viewer.currentPage, x, y };
        this._layoutPending();
        ta.focus();

        // 顯示文字屬性面板
        document.getElementById('text-properties').style.display = 'block';
    }

    /**
     * 依 PDF 座標、字級與目前縮放，擺放輸入框並設定字體大小
     */
    _layoutPending() {
        if (!this.pending) return;
        const viewer = window.pdfViewer;
        const { box, ta, x, y } = this.pending;

        const pos = viewer.pdfToScreen(x, y);
        const scale = 1 / viewer.getScreenToPDFRatio().x;
        box.style.left = pos.x + 'px';
        box.style.top = pos.y + 'px';
        ta.style.fontSize = (this._fontSize() * scale) + 'px';
        ta.style.color = this._fontColor();
        this._autosize();
    }

    _autosize() {
        if (!this.pending) return;
        const ta = this.pending.ta;
        ta.style.width = '0px';
        ta.style.height = '0px';
        const fontPx = parseFloat(ta.style.fontSize) || 14;
        ta.style.width = Math.max(ta.scrollWidth + 2, fontPx * 5) + 'px';
        ta.style.height = Math.max(ta.scrollHeight, fontPx * TEXT_LINE_HEIGHT) + 'px';
    }

    hasPendingInput() {
        return !!this.pending;
    }

    cancelPendingInput() {
        if (this.pending) {
            this.pending.box.remove();
            this.pending = null;
        }
    }

    /**
     * 把正在打的文字放進 PDF。回傳 true 表示可以繼續下一個動作。
     */
    async commitPending() {
        if (!this.pending) return true;
        const p = this.pending;
        if (p.committing) return p.committing;

        const text = p.ta.value.replace(/\s+$/, '');
        if (!text.trim()) {
            this.cancelPendingInput();
            return true;
        }

        const viewer = window.pdfViewer;
        p.committing = (async () => {
            try {
                const resp = await fetch('/api/text/add', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        doc_id: viewer.docId,
                        page_num: p.pageNum,
                        x: p.x,
                        y: p.y,
                        text: text,
                        font_size: this._fontSize(),
                        color: this._hexToRGB(this._fontColor()),
                    }),
                });
                const data = await readJSON(resp);
                if (data.error) throw new Error(data.error);

                // 等新頁面畫好再拿掉輸入框，畫面不會閃一下
                await viewer.reloadAfterEdit(data);
                if (this.pending === p) this.cancelPendingInput();
                return true;
            } catch (e) {
                p.committing = null;
                showToast(`加入文字失敗: ${e.message}`, 'error');
                return false;
            }
        })();
        return p.committing;
    }

    /**
     * 「確認加入文字」按鈕
     */
    async confirmText() {
        if (!this.pending) {
            showToast('請先在頁面上點一下要放文字的位置', 'info');
            return;
        }
        if (!this.pending.ta.value.trim()) {
            showToast('請輸入文字內容', 'info');
            this.pending.ta.focus();
            return;
        }
        if (await this.commitPending()) showToast('文字已加入', 'success');
    }

    // ---- Selection handling ----

    _onMouseDown(e) {
        if (this.isTextInputMode) return;
        if (e.button !== 0) return;

        const rect = this.textOverlay.getBoundingClientRect();
        this.selectionStart = {
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
        };
        this.isSelecting = true;
        // 按住 Ctrl 是「加選」，不要清掉原本選的
        if (!(e.ctrlKey || e.metaKey)) this._clearSelection();

        this.selectionRect.style.display = 'block';
        this.selectionRect.style.left = this.selectionStart.x + 'px';
        this.selectionRect.style.top = this.selectionStart.y + 'px';
        this.selectionRect.style.width = '0';
        this.selectionRect.style.height = '0';
    }

    _onMouseMove(e) {
        if (!this.isSelecting) return;

        const rect = this.textOverlay.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        const left = Math.min(x, this.selectionStart.x);
        const top = Math.min(y, this.selectionStart.y);
        const width = Math.abs(x - this.selectionStart.x);
        const height = Math.abs(y - this.selectionStart.y);

        this.selectionRect.style.left = left + 'px';
        this.selectionRect.style.top = top + 'px';
        this.selectionRect.style.width = width + 'px';
        this.selectionRect.style.height = height + 'px';
    }

    _onMouseUp(e) {
        if (!this.isSelecting) return;
        this.isSelecting = false;

        const selRect = {
            left: parseFloat(this.selectionRect.style.left),
            top: parseFloat(this.selectionRect.style.top),
            width: parseFloat(this.selectionRect.style.width),
            height: parseFloat(this.selectionRect.style.height),
        };

        this.selectionRect.style.display = 'none';

        if (selRect.width < 5 || selRect.height < 5) return;

        // 找出在選取框內的文字
        const spans = this.textOverlay.querySelectorAll('.text-span-overlay');
        spans.forEach((span) => {
            const index = parseInt(span.dataset.index);
            const spanRect = {
                left: parseFloat(span.style.left),
                top: parseFloat(span.style.top),
                right: parseFloat(span.style.left) + parseFloat(span.style.width),
                bottom: parseFloat(span.style.top) + parseFloat(span.style.height),
            };

            // 判斷是否相交
            if (
                spanRect.left < selRect.left + selRect.width &&
                spanRect.right > selRect.left &&
                spanRect.top < selRect.top + selRect.height &&
                spanRect.bottom > selRect.top
            ) {
                this._selectSpan(span, index);
            }
        });

        this._updateSelectionUI();
    }

    _selectSpan(span, index) {
        span.classList.add('selected');
        if (!this.selectedSpans.includes(index)) {
            this.selectedSpans.push(index);
        }
        this._updateSelectionUI();
    }

    _toggleSpan(span, index) {
        if (span.classList.contains('selected')) {
            span.classList.remove('selected');
            this.selectedSpans = this.selectedSpans.filter(i => i !== index);
        } else {
            this._selectSpan(span, index);
        }
        this._updateSelectionUI();
    }

    _clearSelection() {
        this.textOverlay.querySelectorAll('.text-span-overlay.selected').forEach(s => {
            s.classList.remove('selected');
        });
        this.selectedSpans = [];
        this._updateSelectionUI();
    }

    selectAll() {
        this.textOverlay.querySelectorAll('.text-span-overlay').forEach(span => {
            span.classList.add('selected');
            const index = parseInt(span.dataset.index);
            if (!this.selectedSpans.includes(index)) this.selectedSpans.push(index);
        });
        this._updateSelectionUI();
    }

    /**
     * 選取的文字依閱讀順序排好：同一行直接相接，換行處放換行
     */
    _selectedItemsInOrder() {
        const items = this.selectedSpans.map(i => this.textItems[i]).filter(Boolean);
        items.sort((a, b) => {
            const sameLine = Math.abs(a.origin[1] - b.origin[1]) < Math.min(a.size, b.size) * 0.5;
            return sameLine ? a.bbox[0] - b.bbox[0] : a.origin[1] - b.origin[1];
        });
        return items;
    }

    _selectedText() {
        const items = this._selectedItemsInOrder();
        let text = '';
        items.forEach((item, i) => {
            if (i > 0) {
                const prev = items[i - 1];
                const sameLine = Math.abs(item.origin[1] - prev.origin[1]) < Math.min(item.size, prev.size) * 0.5;
                text += sameLine ? '' : '\n';
            }
            text += item.text;
        });
        return text.split('\n').map(l => l.trim()).join('\n');
    }

    _updateSelectionUI() {
        const infoPanel = document.getElementById('selection-info');
        if (this.selectedSpans.length > 0 && !this.isTextInputMode) {
            infoPanel.style.display = 'block';
            const text = this._selectedText();
            this.selectedTextPreview.value = text;
            this._originalSelectedText = text;
            // PDF 內部編碼特殊時，擷取出來的字會是亂碼
            document.getElementById('selection-garbled-hint').style.display =
                /[�-]/.test(text) ? 'block' : 'none';
        } else {
            infoPanel.style.display = 'none';
        }
    }

    /**
     * 修改選取的文字：一次請求完成「刪掉原文字＋在原位置寫入新文字」
     */
    async updateSelectedText() {
        if (this.selectedSpans.length === 0) return;

        const newText = this.selectedTextPreview.value.replace(/\s+$/, '');
        if (!newText.trim()) {
            showToast('若要清空內容，請直接使用「刪除」按鈕', 'info');
            return;
        }
        if (newText === this._originalSelectedText) {
            showToast('文字沒有變更', 'info');
            return;
        }

        const viewer = window.pdfViewer;
        const items = this._selectedItemsInOrder();
        const first = items[0];

        showLoading('修改文字中...');
        try {
            const resp = await fetch('/api/text/replace', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    doc_id: viewer.docId,
                    page_num: viewer.currentPage,
                    rects: items.map(item => item.bbox),
                    // 沿用原文字的位置、字級與顏色
                    x: first.bbox[0],
                    baseline: first.origin[1],
                    text: newText,
                    font_size: first.size || 12,
                    color: first.color || 0,
                }),
            });
            const data = await readJSON(resp);
            if (data.error) throw new Error(data.error);

            this._clearSelection();
            await viewer.reloadAfterEdit(data);

            hideLoading();
            showToast('文字修改成功', 'success');
        } catch (e) {
            hideLoading();
            showToast(`修改失敗: ${e.message}`, 'error');
        }
    }

    /**
     * 複製選取的文字到剪貼簿
     */
    async copySelectedText() {
        const text = this.selectedTextPreview.value || this._selectedText();
        if (!text) return;

        try {
            await navigator.clipboard.writeText(text);
            showToast('已複製到剪貼簿', 'success');
        } catch (e) {
            // Fallback
            const ta = document.createElement('textarea');
            ta.value = text;
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            showToast('已複製到剪貼簿', 'success');
        }
    }

    /**
     * 刪除選取的文字（多段一次刪，算一步上一步）
     */
    async deleteSelectedText() {
        if (this.selectedSpans.length === 0) return;

        const viewer = window.pdfViewer;
        const rects = this.selectedSpans.map(i => this.textItems[i]?.bbox).filter(Boolean);
        showLoading('刪除文字中...');

        try {
            const resp = await fetch('/api/text/delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    doc_id: viewer.docId,
                    page_num: viewer.currentPage,
                    rects: rects,
                }),
            });
            const data = await readJSON(resp);
            if (data.error) throw new Error(data.error);

            this._clearSelection();
            await viewer.reloadAfterEdit(data);

            hideLoading();
            showToast('文字已刪除', 'success');
        } catch (e) {
            hideLoading();
            showToast(`刪除失敗: ${e.message}`, 'error');
        }
    }

    _showContextMenu(x, y) {
        const menu = document.getElementById('context-menu');
        menu.style.left = x + 'px';
        menu.style.top = y + 'px';
        menu.classList.add('visible');
    }

    _hexToRGB(hex) {
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        return result ? [
            parseInt(result[1], 16),
            parseInt(result[2], 16),
            parseInt(result[3], 16),
        ] : [0, 0, 0];
    }

    /**
     * 頁面尺寸或縮放變更時更新覆蓋層
     */
    updateOverlaySize() {
        this._renderTextOverlay();
        this._layoutPending();
    }
}

// Global instance
window.textEditor = new TextEditor();
