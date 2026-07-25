/**
 * 文字編輯器模組
 * 處理文字選取、複製、刪除、新增文字
 */
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
        this.textInputOverlay = null;

        this._bindEvents();
    }

    _bindEvents() {
        // 選取框拖拽
        this.textOverlay.addEventListener('mousedown', (e) => this._onMouseDown(e));
        this.textOverlay.addEventListener('mousemove', (e) => this._onMouseMove(e));
        this.textOverlay.addEventListener('mouseup', (e) => this._onMouseUp(e));

        // 右鍵選單
        this.textOverlay.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            if (this.selectedSpans.length > 0) {
                this._showContextMenu(e.clientX, e.clientY);
            }
        });
    }

    /**
     * 載入頁面文字座標
     */
    async loadTextBlocks(docId, pageNum) {
        try {
            const resp = await fetch(`/api/page/${docId}/${pageNum}/text`);
            const data = await resp.json();
            if (data.error) return;

            this.textItems = data.text_items || [];
            this.selectedSpans = [];
            this._renderTextOverlay();
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

            this.textOverlay.appendChild(span);
        });
    }

    /**
     * 啟用選取模式
     */
    enableSelectMode() {
        this.isTextInputMode = false;
        this.textOverlay.classList.add('selecting');
        this._removeTextInputOverlay();
    }

    /**
     * 啟用文字輸入模式
     */
    enableTextInputMode() {
        this.isTextInputMode = true;
        this.textOverlay.classList.add('selecting');
        this._clearSelection();

        // 監聽點擊事件來放置文字
        this._textClickHandler = (e) => {
            if (!this.isTextInputMode) return;
            const rect = this.textOverlay.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            this._createTextInput(x, y);
        };
        this.textOverlay.addEventListener('click', this._textClickHandler);
    }

    /**
     * 停用所有模式
     */
    disable() {
        this.isTextInputMode = false;
        this.textOverlay.classList.remove('selecting');
        if (this._textClickHandler) {
            this.textOverlay.removeEventListener('click', this._textClickHandler);
            this._textClickHandler = null;
        }
    }

    /**
     * 建立文字輸入框
     */
    _createTextInput(x, y) {
        this._removeTextInputOverlay();

        const overlay = document.createElement('div');
        overlay.style.cssText = `
            position: absolute;
            left: ${x}px;
            top: ${y}px;
            min-width: 100px;
            z-index: 30;
        `;

        const textarea = document.createElement('textarea');
        textarea.style.cssText = `
            width: 200px;
            min-height: 40px;
            background: rgba(255,255,255,0.95);
            border: 2px solid #6366f1;
            border-radius: 4px;
            padding: 6px 8px;
            font-size: ${document.getElementById('font-size-input').value}px;
            color: ${document.getElementById('font-color-input').value};
            font-family: 'Noto Sans TC', 'Inter', sans-serif;
            resize: both;
            outline: none;
        `;
        textarea.placeholder = '輸入文字...';

        overlay.appendChild(textarea);
        this.textOverlay.appendChild(overlay);
        this.textInputOverlay = overlay;
        textarea.focus();

        // 顯示文字屬性面板
        document.getElementById('text-properties').style.display = 'block';

        // 即時更新字型大小和顏色
        const fontSizeInput = document.getElementById('font-size-input');
        const fontColorInput = document.getElementById('font-color-input');

        fontSizeInput.addEventListener('input', () => {
            textarea.style.fontSize = fontSizeInput.value + 'px';
        });
        fontColorInput.addEventListener('input', () => {
            textarea.style.color = fontColorInput.value;
        });

        // 記錄位置
        this.textInputOverlay._posX = x;
        this.textInputOverlay._posY = y;
    }

    _removeTextInputOverlay() {
        if (this.textInputOverlay) {
            this.textInputOverlay.remove();
            this.textInputOverlay = null;
        }
    }

    /**
     * 確認並提交文字到 PDF
     */
    async confirmText() {
        if (!this.textInputOverlay) {
            showToast('請先在頁面上點擊以放置文字', 'info');
            return;
        }

        const textarea = this.textInputOverlay.querySelector('textarea');
        const text = textarea.value.trim();
        if (!text) {
            showToast('請輸入文字內容', 'info');
            return;
        }

        const viewer = window.pdfViewer;
        const x = this.textInputOverlay._posX;
        const y = this.textInputOverlay._posY;
        const pdfPos = viewer.screenToPDF(x, y);

        const fontSize = parseFloat(document.getElementById('font-size-input').value);
        const colorHex = document.getElementById('font-color-input').value;
        const color = this._hexToRGB(colorHex);

        showLoading('正在加入文字...');
        try {
            const resp = await fetch('/api/text/add', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    doc_id: viewer.docId,
                    page_num: viewer.currentPage,
                    x: pdfPos.x,
                    y: pdfPos.y + fontSize, // 基線調整
                    text: text,
                    font_size: fontSize,
                    color: color,
                }),
            });
            const data = await resp.json();
            if (data.error) throw new Error(data.error);

            // 記錄 undo
            const undoData = {
                docId: viewer.docId,
                pageNum: viewer.currentPage,
                rect: [pdfPos.x - 1, pdfPos.y - 1, pdfPos.x + 300, pdfPos.y + fontSize + 5],
            };
            window.undoManager.push({
                type: 'add_text',
                data: undoData,
                undo: async () => {
                    await fetch('/api/text/delete', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            doc_id: undoData.docId,
                            page_num: undoData.pageNum,
                            rect: undoData.rect,
                        }),
                    });
                    await viewer.refreshCurrentPage();
                },
                redo: async () => {
                    await fetch('/api/text/add', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            doc_id: undoData.docId,
                            page_num: undoData.pageNum,
                            x: pdfPos.x,
                            y: pdfPos.y + fontSize,
                            text: text,
                            font_size: fontSize,
                            color: color,
                        }),
                    });
                    await viewer.refreshCurrentPage();
                },
            });

            this._removeTextInputOverlay();
            await viewer.refreshCurrentPage();
            await this.loadTextBlocks(viewer.docId, viewer.currentPage);
            await viewer.refreshThumbnails();

            hideLoading();
            showToast('文字已加入', 'success');
        } catch (e) {
            hideLoading();
            showToast(`加入失敗: ${e.message}`, 'error');
        }
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
        this._clearSelection();

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
        spans.forEach((span, index) => {
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

    _updateSelectionUI() {
        const infoPanel = document.getElementById('selection-info');
        if (this.selectedSpans.length > 0) {
            infoPanel.style.display = 'block';
            const text = this.selectedSpans.map(i => this.textItems[i]?.text || '').join(' ');
            this.selectedTextPreview.value = text;
        } else {
            infoPanel.style.display = 'none';
        }
    }

    /**
     * 修改選取的文字（先刪除舊文字，再插入新文字）
     */
    async updateSelectedText() {
        if (this.selectedSpans.length === 0) return;

        const newText = this.selectedTextPreview.value.trim();
        if (!newText) {
            showToast('若要清空內容，請直接使用「刪除」按鈕', 'info');
            return;
        }

        const viewer = window.pdfViewer;
        showLoading('修改文字中...');

        try {
            // 取得第一個選取文字區塊的座標與字型大小作為基準
            const firstIdx = this.selectedSpans[0];
            const firstItem = this.textItems[firstIdx];

            const x = firstItem ? firstItem.bbox[0] : 72;
            const y = firstItem ? firstItem.bbox[1] : 72;
            const fontSize = firstItem ? (firstItem.size || 12) : 12;

            // 1. 刪除原本選取的文字區塊
            for (const idx of this.selectedSpans) {
                const item = this.textItems[idx];
                if (!item) continue;
                await fetch('/api/text/delete', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        doc_id: viewer.docId,
                        page_num: viewer.currentPage,
                        rect: item.bbox,
                    }),
                });
            }

            // 2. 在第一項位置寫入新文字
            const fontColorHex = document.getElementById('font-color-input')?.value || '#000000';
            const color = this._hexToRGB(fontColorHex);

            await fetch('/api/text/add', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    doc_id: viewer.docId,
                    page_num: viewer.currentPage,
                    x: x,
                    y: y + fontSize * 0.8, // 調整基線位置
                    text: newText,
                    font_size: fontSize,
                    color: color,
                }),
            });

            this._clearSelection();
            await viewer.refreshCurrentPage();
            await this.loadTextBlocks(viewer.docId, viewer.currentPage);
            await viewer.refreshThumbnails();

            hideLoading();
            showToast('文字修改成功！', 'success');
        } catch (e) {
            hideLoading();
            showToast(`修改失敗: ${e.message}`, 'error');
        }
    }

    /**
     * 複製選取的文字到剪貼簿
     */
    async copySelectedText() {
        const text = this.selectedTextPreview.value || this.selectedSpans.map(i => this.textItems[i]?.text || '').join(' ');
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
     * 刪除選取的文字
     */
    async deleteSelectedText() {
        if (this.selectedSpans.length === 0) return;

        const viewer = window.pdfViewer;
        showLoading('刪除文字中...');

        try {
            // 計算包含所有選中文字的最小矩形
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const idx of this.selectedSpans) {
                const item = this.textItems[idx];
                if (!item) continue;
                minX = Math.min(minX, item.bbox[0]);
                minY = Math.min(minY, item.bbox[1]);
                maxX = Math.max(maxX, item.bbox[2]);
                maxY = Math.max(maxY, item.bbox[3]);
            }

            // 逐個選取項目刪除（更精確）
            for (const idx of this.selectedSpans) {
                const item = this.textItems[idx];
                if (!item) continue;
                await fetch('/api/text/delete', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        doc_id: viewer.docId,
                        page_num: viewer.currentPage,
                        rect: item.bbox,
                    }),
                });
            }

            this._clearSelection();
            await viewer.refreshCurrentPage();
            await this.loadTextBlocks(viewer.docId, viewer.currentPage);
            await viewer.refreshThumbnails();

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

        const closeMenu = () => {
            menu.classList.remove('visible');
            document.removeEventListener('click', closeMenu);
        };
        setTimeout(() => document.addEventListener('click', closeMenu), 10);
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
     * 頁面尺寸變更時更新覆蓋層
     */
    updateOverlaySize() {
        this._renderTextOverlay();
    }
}

// Global instance
window.textEditor = new TextEditor();
