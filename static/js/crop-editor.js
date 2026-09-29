/**
 * 裁切編輯器模組
 * 處理水平切割線、切片即時顯示、選擇保留
 *
 * 切割線以 PDF 座標（pt）記錄，畫面縮放時位置不會跑掉；
 * 每次切割線有變動就重算切片，不需要另外按「預覽」。
 */
class CropEditor {
    constructor() {
        this.cropOverlay = document.getElementById('crop-overlay');
        this.cutLines = []; // [{y: PDF 座標, id: number}]
        this.removed = new Set(); // 被標成「移除」的切片（以切片順序記）
        this.nextId = 0;
        this.isActive = false;
    }

    /**
     * 啟用裁切模式
     */
    activate() {
        this.isActive = true;
        this.cropOverlay.classList.remove('hidden');
        document.getElementById('crop-controls').style.display = 'block';
        this._render();
        this._updateCutLinesList();
    }

    /**
     * 停用裁切模式
     */
    deactivate() {
        this.isActive = false;
        this.cropOverlay.classList.add('hidden');
        document.getElementById('crop-controls').style.display = 'none';
        this.reset();
    }

    reset() {
        this.cutLines = [];
        this.removed.clear();
        this.nextId = 0;
        this.cropOverlay.innerHTML = '';
        this._updateCutLinesList();
    }

    _pageHeight() {
        const viewer = window.pdfViewer;
        return viewer.pageInfo?.pages?.[viewer.currentPage]?.height || 0;
    }

    /**
     * 新增切割線（放在目前最大空白的中間）
     */
    addCutLine() {
        const viewer = window.pdfViewer;
        if (!viewer.docId) return;

        const height = this._pageHeight();
        const existing = this.cutLines.map(l => l.y).sort((a, b) => a - b);
        let maxGap = 0;
        let gapStart = 0;
        let prev = 0;
        for (const lineY of [...existing, height]) {
            if (lineY - prev > maxGap) {
                maxGap = lineY - prev;
                gapStart = prev;
            }
            prev = lineY;
        }

        this.cutLines.push({ y: gapStart + maxGap / 2, id: this.nextId++ });
        this.removed.clear();
        this._render();
        this._updateCutLinesList();
    }

    /**
     * 移除切割線
     */
    removeCutLine(id) {
        this.cutLines = this.cutLines.filter(l => l.id !== id);
        this.removed.clear();
        this._render();
        this._updateCutLinesList();
    }

    /**
     * 依切割線算出切片（PDF 座標）
     */
    _slices() {
        const height = this._pageHeight();
        const lines = this.cutLines.map(l => l.y).sort((a, b) => a - b);
        const slices = [];
        let prev = 0;
        for (const y of [...lines, height]) {
            if (y - prev > 1) slices.push({ top: prev, bottom: y });
            prev = y;
        }
        return slices;
    }

    /**
     * 渲染切割線和切片
     */
    _render() {
        this.cropOverlay.innerHTML = '';
        const viewer = window.pdfViewer;
        if (!viewer.docId) return;

        // 有切割線才顯示切片與「保留／移除」按鈕
        if (this.cutLines.length > 0) {
            this._slices().forEach((slice, index) => {
                const screenTop = viewer.pdfToScreen(0, slice.top).y;
                const screenBottom = viewer.pdfToScreen(0, slice.bottom).y;
                const keep = !this.removed.has(index);

                const sliceEl = document.createElement('div');
                sliceEl.className = 'crop-slice' + (keep ? '' : ' excluded');
                sliceEl.style.top = screenTop + 'px';
                sliceEl.style.height = (screenBottom - screenTop) + 'px';

                const toggleBtn = document.createElement('button');
                toggleBtn.className = 'slice-toggle';
                toggleBtn.textContent = keep ? `第 ${index + 1} 段：保留（點一下改成移除）` : `第 ${index + 1} 段：移除（點一下改回保留）`;
                toggleBtn.addEventListener('click', () => {
                    if (this.removed.has(index)) this.removed.delete(index);
                    else this.removed.add(index);
                    this._render();
                });

                sliceEl.appendChild(toggleBtn);
                this.cropOverlay.appendChild(sliceEl);
            });
        }

        // 渲染切割線
        const height = this._pageHeight();
        for (const line of this.cutLines) {
            const lineEl = document.createElement('div');
            lineEl.className = 'crop-line';
            lineEl.style.top = viewer.pdfToScreen(0, line.y).y + 'px';
            lineEl.title = '上下拖曳調整位置';

            const label = document.createElement('span');
            label.className = 'crop-label';
            label.textContent = `切割線 ${line.id + 1}`;
            lineEl.appendChild(label);

            // 拖拽
            lineEl.addEventListener('mousedown', (e) => {
                if (e.target.closest('button')) return;
                e.preventDefault();

                const onMove = (e2) => {
                    const wrapperRect = document.getElementById('pdf-canvas-wrapper').getBoundingClientRect();
                    const pdfY = viewer.screenToPDF(0, e2.clientY - wrapperRect.top).y;
                    line.y = Math.max(5, Math.min(height - 5, pdfY));
                    lineEl.style.top = viewer.pdfToScreen(0, line.y).y + 'px';
                };

                const onUp = () => {
                    document.removeEventListener('mousemove', onMove);
                    document.removeEventListener('mouseup', onUp);
                    this._render();
                    this._updateCutLinesList();
                };

                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
            });

            // 刪除按鈕
            const delBtn = document.createElement('button');
            delBtn.className = 'crop-line-delete';
            delBtn.title = '刪除這條切割線';
            delBtn.textContent = '×';
            delBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.removeCutLine(line.id);
            });
            lineEl.appendChild(delBtn);

            this.cropOverlay.appendChild(lineEl);
        }
    }

    /**
     * 更新側邊欄切割線列表
     */
    _updateCutLinesList() {
        const list = document.getElementById('cut-lines-list');
        list.innerHTML = '';

        if (this.cutLines.length === 0) {
            list.innerHTML = '<div class="panel-hint">還沒有切割線。按上方按鈕新增，再到頁面上拖曳紅線調整位置。</div>';
            return;
        }

        const sorted = [...this.cutLines].sort((a, b) => a.y - b.y);
        sorted.forEach(line => {
            const item = document.createElement('div');
            item.className = 'cut-line-item';

            const label = document.createElement('span');
            label.textContent = `切割線 ${line.id + 1}（距頂端 ${Math.round(line.y)} pt）`;

            const del = document.createElement('button');
            del.className = 'cut-line-remove';
            del.title = '刪除這條切割線';
            del.textContent = '×';
            del.addEventListener('click', () => this.removeCutLine(line.id));

            item.appendChild(label);
            item.appendChild(del);
            list.appendChild(item);
        });
    }

    /**
     * 套用裁切
     */
    async applyCrop() {
        const viewer = window.pdfViewer;
        if (!viewer.docId || this.cutLines.length === 0) {
            showToast('請先新增至少一條切割線', 'info');
            return;
        }

        const keptSlices = this._slices().filter((_, i) => !this.removed.has(i));
        if (keptSlices.length === 0) {
            showToast('至少需保留一段', 'error');
            return;
        }

        showLoading('正在裁切頁面...');

        try {
            const resp = await fetch('/api/crop', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    doc_id: viewer.docId,
                    page_num: viewer.currentPage,
                    slices: keptSlices,
                }),
            });
            const data = await readJSON(resp);
            if (data.error) throw new Error(data.error);

            this.reset();
            await viewer.reloadAfterEdit(data);

            hideLoading();
            showToast(`裁切完成：這一頁變成 ${keptSlices.length} 頁（可按「上一步」還原）`, 'success');
        } catch (e) {
            hideLoading();
            showToast(`裁切失敗: ${e.message}`, 'error');
        }
    }

    /**
     * 更新尺寸
     */
    resize() {
        if (this.isActive) {
            this._render();
        }
    }
}

// Global instance
window.cropEditor = new CropEditor();
