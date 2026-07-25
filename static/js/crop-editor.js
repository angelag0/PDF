/**
 * 裁切編輯器模組
 * 處理水平切割線、切片預覽、選擇保留
 */
class CropEditor {
    constructor() {
        this.cropOverlay = document.getElementById('crop-overlay');
        this.cutLines = []; // [{y: number, id: number}]
        this.slices = [];   // [{top, bottom, index, keep}]
        this.nextId = 0;
        this.isActive = false;
        this.dragLine = null;
        this.dragOffsetY = 0;
    }

    /**
     * 啟用裁切模式
     */
    activate() {
        this.isActive = true;
        this.cropOverlay.classList.remove('hidden');
        document.getElementById('crop-controls').style.display = 'block';
        this._render();
    }

    /**
     * 停用裁切模式
     */
    deactivate() {
        this.isActive = false;
        this.cropOverlay.classList.add('hidden');
        document.getElementById('crop-controls').style.display = 'none';
        this.cutLines = [];
        this.slices = [];
        this.cropOverlay.innerHTML = '';
    }

    /**
     * 新增切割線
     */
    addCutLine() {
        const viewer = window.pdfViewer;
        if (!viewer.docId) return;

        const wrapperHeight = parseFloat(
            document.getElementById('pdf-canvas-wrapper').style.height
        );

        // 預設放在頁面中間或均分
        let y = wrapperHeight / 2;
        if (this.cutLines.length > 0) {
            // 找最大間距的中點
            const existing = this.cutLines.map(l => l.y).sort((a, b) => a - b);
            let maxGap = 0;
            let gapStart = 0;
            let prev = 0;
            for (const lineY of existing) {
                if (lineY - prev > maxGap) {
                    maxGap = lineY - prev;
                    gapStart = prev;
                }
                prev = lineY;
            }
            if (wrapperHeight - prev > maxGap) {
                maxGap = wrapperHeight - prev;
                gapStart = prev;
            }
            y = gapStart + maxGap / 2;
        }

        const id = this.nextId++;
        this.cutLines.push({ y, id });

        this._render();
        this._updateCutLinesList();
    }

    /**
     * 移除切割線
     */
    removeCutLine(id) {
        this.cutLines = this.cutLines.filter(l => l.id !== id);
        this._render();
        this._updateCutLinesList();
    }

    /**
     * 渲染切割線和切片
     */
    _render() {
        this.cropOverlay.innerHTML = '';

        const wrapperHeight = parseFloat(
            document.getElementById('pdf-canvas-wrapper').style.height
        );

        // 渲染切片區域
        if (this.slices.length > 0) {
            for (const slice of this.slices) {
                const viewer = window.pdfViewer;
                const screenTop = viewer.pdfToScreen(0, slice.top).y;
                const screenBottom = viewer.pdfToScreen(0, slice.bottom).y;

                const sliceEl = document.createElement('div');
                sliceEl.className = 'crop-slice' + (slice.keep ? '' : ' excluded');
                sliceEl.style.top = screenTop + 'px';
                sliceEl.style.height = (screenBottom - screenTop) + 'px';

                const toggleBtn = document.createElement('button');
                toggleBtn.className = 'slice-toggle';
                toggleBtn.textContent = slice.keep ? '✓ 保留' : '✕ 移除';
                toggleBtn.addEventListener('click', () => {
                    slice.keep = !slice.keep;
                    this._render();
                });

                sliceEl.appendChild(toggleBtn);
                this.cropOverlay.appendChild(sliceEl);
            }
        }

        // 渲染切割線
        for (const line of this.cutLines) {
            const lineEl = document.createElement('div');
            lineEl.className = 'crop-line';
            lineEl.style.top = line.y + 'px';

            const label = document.createElement('span');
            label.className = 'crop-label';
            label.textContent = `切割線 ${line.id + 1}`;
            lineEl.appendChild(label);

            // 拖拽
            lineEl.addEventListener('mousedown', (e) => {
                e.preventDefault();
                this.dragLine = line;
                this.dragOffsetY = e.clientY - line.y;

                const onMove = (e2) => {
                    const wrapperRect = document.getElementById('pdf-canvas-wrapper').getBoundingClientRect();
                    let newY = e2.clientY - wrapperRect.top;
                    newY = Math.max(10, Math.min(wrapperHeight - 10, newY));
                    line.y = newY;
                    lineEl.style.top = newY + 'px';
                };

                const onUp = () => {
                    this.dragLine = null;
                    document.removeEventListener('mousemove', onMove);
                    document.removeEventListener('mouseup', onUp);
                    this._updateCutLinesList();
                };

                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
            });

            // 刪除按鈕
            const delBtn = document.createElement('button');
            delBtn.style.cssText = `
                position: absolute; right: 4px; top: -12px;
                width: 20px; height: 20px; border-radius: 50%;
                border: none; background: var(--accent-danger);
                color: white; font-size: 12px; cursor: pointer;
                display: flex; align-items: center; justify-content: center;
                opacity: 0; transition: opacity 0.2s;
            `;
            delBtn.textContent = '×';
            delBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.removeCutLine(line.id);
            });
            lineEl.addEventListener('mouseenter', () => delBtn.style.opacity = '1');
            lineEl.addEventListener('mouseleave', () => delBtn.style.opacity = '0');
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

        const viewer = window.pdfViewer;
        const sorted = [...this.cutLines].sort((a, b) => a.y - b.y);

        sorted.forEach(line => {
            const pdfY = viewer.screenToPDF(0, line.y).y;
            const item = document.createElement('div');
            item.style.cssText = `
                display: flex; align-items: center; justify-content: space-between;
                padding: 4px 8px; background: var(--bg-tertiary); border-radius: 4px;
                font-size: 12px;
            `;
            item.innerHTML = `
                <span>切割線 ${line.id + 1} (Y: ${Math.round(pdfY)}pt)</span>
                <button onclick="cropEditor.removeCutLine(${line.id})" 
                    style="border:none; background:transparent; color:var(--accent-danger); cursor:pointer; font-size:14px;">
                    ×
                </button>
            `;
            list.appendChild(item);
        });
    }

    /**
     * 預覽切片結果
     */
    async previewCrop() {
        const viewer = window.pdfViewer;
        if (!viewer.docId) return;

        // 將畫面座標轉為 PDF 座標
        const pdfCutLines = this.cutLines.map(l => viewer.screenToPDF(0, l.y).y);

        try {
            const resp = await fetch('/api/crop/preview', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    doc_id: viewer.docId,
                    page_num: viewer.currentPage,
                    cut_lines: pdfCutLines,
                }),
            });
            const data = await resp.json();
            if (data.error) throw new Error(data.error);

            this.slices = data.slices.map(s => ({ ...s, keep: true }));
            this._render();
            showToast(`已產生 ${this.slices.length} 個切片`, 'info');
        } catch (e) {
            showToast(`預覽失敗: ${e.message}`, 'error');
        }
    }

    /**
     * 套用裁切
     */
    async applyCrop() {
        const viewer = window.pdfViewer;
        if (!viewer.docId || this.slices.length === 0) {
            showToast('請先新增切割線並預覽', 'info');
            return;
        }

        const keptSlices = this.slices.filter(s => s.keep);
        if (keptSlices.length === 0) {
            showToast('至少需保留一個切片', 'error');
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
                    slices: keptSlices.map(s => ({
                        top: s.top,
                        bottom: s.bottom,
                    })),
                }),
            });
            const data = await resp.json();
            if (data.error) throw new Error(data.error);

            // 更新頁面
            viewer.pageCount = data.page_count;

            const infoResp = await fetch(`/api/doc/${viewer.docId}/info`);
            viewer.pageInfo = await infoResp.json();

            this.cutLines = [];
            this.slices = [];
            this.cropOverlay.innerHTML = '';

            await viewer.loadThumbnails();
            await viewer.renderPage(viewer.currentPage);

            hideLoading();
            showToast('裁切完成', 'success');
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
