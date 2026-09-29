/**
 * PDF 檢視器模組
 * 處理 PDF 頁面渲染、縮圖導航、縮放控制
 */
class PDFViewer {
    constructor() {
        this.docId = null;
        this.pageCount = 0;
        this.currentPage = 0;
        this.zoom = 1.0;
        this.renderZoom = 2.0; // 後端渲染解析度
        this.pageInfo = null;

        // DOM elements
        this.canvasContainer = document.getElementById('canvas-container');
        this.canvasWrapper = document.getElementById('pdf-canvas-wrapper');
        this.pageImg = document.getElementById('pdf-page-img');
        this.thumbnailList = document.getElementById('thumbnail-list');
        this.uploadScreen = document.getElementById('upload-screen');

        // Callbacks
        this.onPageChange = null;
        this.onDocLoaded = null;
        // 換頁前呼叫（例如把還在打字的內容先放進 PDF）；回傳 false 則不換頁
        this.beforePageChange = null;
        this._pendingResolve = null;
        // 內容版本：每次修改 +1，讓各模組知道要重新抓文字位置
        this.contentVersion = 0;
    }

    /**
     * 上傳並載入 PDF
     */
    async loadPDF(file) {
        showLoading('正在載入 PDF...');
        try {
            const data = await uploadPDF(file);

            // 新檔的資訊先拿到，確定開得起來再換掉舊檔
            const infoResp = await fetch(`/api/doc/${data.doc_id}/info`);
            const pageInfo = await readJSON(infoResp);
            if (pageInfo.error) throw new Error(pageInfo.error);

            // 換檔：釋放舊檔（合併清單還用得到的就留著），清掉上一個檔的編輯狀態
            const oldDocId = this.docId;
            if (oldDocId && !window.mergeEditor.usesDoc(oldDocId)) {
                await fetch(`/api/close/${oldDocId}`, { method: 'POST' }).catch(() => {});
            }
            window.textEditor.cancelPendingInput();
            window.imageEditor.clearAll();
            window.cropEditor.reset();
            window.undoManager.clear();

            this.docId = data.doc_id;
            this.filename = data.filename;
            this.locked = !!data.locked;
            this.contentVersion++;
            this.pageCount = data.page_count;
            this.currentPage = 0;
            this.pageInfo = pageInfo;

            // 顯示編輯區域
            this.uploadScreen.classList.add('hidden');
            this.canvasContainer.classList.remove('hidden');

            // 更新 UI 資訊
            const label = data.filename + (data.locked ? '（有密碼）' : '');
            document.getElementById('info-filename').textContent = data.filename;
            const status = document.getElementById('status-doc');
            status.innerHTML = '';
            const statusSpan = document.createElement('span');
            statusSpan.textContent = label;
            status.appendChild(statusSpan);

            // 載入縮圖
            await this.loadThumbnails();

            // 渲染第一頁，並縮放到適合視窗寬度（最大 150%）
            await this.renderPage(0);
            this.zoomFit(1.5);

            hideLoading();
            showToast(`成功載入「${data.filename}」（共 ${data.page_count} 頁）`, 'success');
            if (data.locked) {
                showToast('這份檔案有密碼：匯出 PDF 時可以選擇要不要保留密碼', 'info');
            }

            if (this.onDocLoaded) {
                this.onDocLoaded(this.docId, this.pageCount);
            }
        } catch (e) {
            hideLoading();
            showToast(e.cancelled ? e.message : `開啟失敗：${e.message}`, e.cancelled ? 'info' : 'error');
        }
    }

    /**
     * 換頁（使用者操作的入口）：先讓各編輯器收尾，再渲染
     */
    async goToPage(pageNum) {
        if (!this.docId || pageNum < 0 || pageNum >= this.pageCount || pageNum === this.currentPage) return;
        if (this.beforePageChange) {
            const proceed = await this.beforePageChange(pageNum);
            if (proceed === false) return;
        }
        await this.renderPage(pageNum);
    }

    /**
     * 任何修改（含上一步／下一步）之後：同步頁數、頁面尺寸、縮圖與按鈕狀態
     */
    async reloadAfterEdit(data) {
        window.undoManager.sync(data);
        this.contentVersion++;
        const countChanged = data.page_count !== undefined && data.page_count !== this.pageCount;
        if (data.page_count !== undefined) this.pageCount = data.page_count;

        const infoResp = await fetch(`/api/doc/${this.docId}/info`);
        const pageInfo = await readJSON(infoResp);
        if (pageInfo.error) throw new Error(pageInfo.error);
        this.pageInfo = pageInfo;

        if (this.currentPage >= this.pageCount) this.currentPage = this.pageCount - 1;
        if (countChanged) {
            await this.loadThumbnails();
        } else {
            this.refreshThumbnails();
        }
        await this.renderPage(this.currentPage);
    }

    /**
     * 渲染指定頁面
     */
    async renderPage(pageNum) {
        if (!this.docId || pageNum < 0 || pageNum >= this.pageCount) return;

        this.currentPage = pageNum;
        const url = `/api/page/${this.docId}/${pageNum}?zoom=${this.renderZoom}&t=${Date.now()}`;

        // 連續快速換頁時，先前還沒載完的那次直接結束，避免有人一直等不到
        if (this._pendingResolve) {
            this._pendingResolve();
            this._pendingResolve = null;
        }

        return new Promise((resolve, reject) => {
            this._pendingResolve = resolve;
            this.pageImg.onload = () => {
                this._pendingResolve = null;
                // 根據顯示縮放調整大小
                const displayWidth = this.pageImg.naturalWidth * (this.zoom / this.renderZoom);
                const displayHeight = this.pageImg.naturalHeight * (this.zoom / this.renderZoom);
                this.pageImg.style.width = displayWidth + 'px';
                this.pageImg.style.height = displayHeight + 'px';
                this.canvasWrapper.style.width = displayWidth + 'px';
                this.canvasWrapper.style.height = displayHeight + 'px';

                // 更新頁面資訊
                const info = this.pageInfo?.pages?.[pageNum];
                document.getElementById('info-page').textContent = `${pageNum + 1} / ${this.pageCount}`;
                if (info) {
                    document.getElementById('info-size').textContent =
                        `${Math.round(info.width)} × ${Math.round(info.height)} pt`;
                }

                // 更新縮圖選中狀態
                this.updateThumbnailActive(pageNum);

                if (this.onPageChange) {
                    this.onPageChange(pageNum, displayWidth, displayHeight);
                }
                resolve();
            };
            this.pageImg.onerror = () => {
                this._pendingResolve = null;
                showToast('頁面載入失敗，程式可能已重新啟動，請重新開啟檔案', 'error');
                reject(new Error('頁面載入失敗'));
            };
            this.pageImg.src = url;
        });
    }

    /**
     * 重新渲染當前頁（用於編輯後刷新）
     */
    async refreshCurrentPage() {
        await this.renderPage(this.currentPage);
    }

    /**
     * 載入所有縮圖
     */
    async loadThumbnails() {
        this.thumbnailList.innerHTML = '';

        for (let i = 0; i < this.pageCount; i++) {
            const item = document.createElement('div');
            item.className = 'thumbnail-item' + (i === this.currentPage ? ' active' : '');
            item.dataset.page = i;

            const img = document.createElement('img');
            img.src = `/api/thumbnail/${this.docId}/${i}?t=${Date.now()}`;
            img.alt = `第 ${i + 1} 頁`;
            img.loading = 'lazy';

            const label = document.createElement('span');
            label.className = 'thumbnail-label';
            label.textContent = i + 1;

            item.appendChild(img);
            item.appendChild(label);

            item.addEventListener('click', () => {
                this.goToPage(i);
            });

            this.thumbnailList.appendChild(item);
        }
    }

    /**
     * 刷新所有縮圖（用於編輯後更新）
     */
    async refreshThumbnails() {
        const items = this.thumbnailList.querySelectorAll('.thumbnail-item img');
        items.forEach((img, i) => {
            img.src = `/api/thumbnail/${this.docId}/${i}?t=${Date.now()}`;
        });
    }

    /**
     * 更新縮圖選中狀態
     */
    updateThumbnailActive(pageNum) {
        this.thumbnailList.querySelectorAll('.thumbnail-item').forEach((item, i) => {
            item.classList.toggle('active', i === pageNum);
        });
    }

    /**
     * 設定縮放
     */
    setZoom(zoom) {
        this.zoom = Math.max(0.25, Math.min(5.0, zoom));
        document.getElementById('zoom-value').textContent = Math.round(this.zoom * 100) + '%';

        // 放大時提高渲染解析度，避免字變糊
        const needed = Math.min(5, Math.max(2, Math.ceil(this.zoom * (window.devicePixelRatio || 1))));
        if (this.docId && needed !== this.renderZoom) {
            this.renderZoom = needed;
            this.renderPage(this.currentPage);
            return;
        }

        if (this.docId) {
            const displayWidth = this.pageImg.naturalWidth * (this.zoom / this.renderZoom);
            const displayHeight = this.pageImg.naturalHeight * (this.zoom / this.renderZoom);
            this.pageImg.style.width = displayWidth + 'px';
            this.pageImg.style.height = displayHeight + 'px';
            this.canvasWrapper.style.width = displayWidth + 'px';
            this.canvasWrapper.style.height = displayHeight + 'px';

            if (this.onPageChange) {
                this.onPageChange(this.currentPage, displayWidth, displayHeight);
            }
        }
    }

    zoomIn() {
        this.setZoom(this.zoom + 0.1);
    }

    zoomOut() {
        this.setZoom(this.zoom - 0.1);
    }

    zoomFit(maxZoom = 5.0) {
        if (!this.docId) return;
        const info = this.pageInfo?.pages?.[this.currentPage];
        if (!info) return;
        const containerWidth = this.canvasContainer.clientWidth - 48;
        this.setZoom(Math.min(maxZoom, containerWidth / info.width));
    }

    /**
     * 上一頁
     */
    prevPage() {
        if (this.currentPage > 0) {
            this.goToPage(this.currentPage - 1);
        }
    }

    /**
     * 下一頁
     */
    nextPage() {
        if (this.currentPage < this.pageCount - 1) {
            this.goToPage(this.currentPage + 1);
        }
    }

    /**
     * 取得當前頁面的 PDF 座標比例
     * 螢幕座標 → PDF 座標
     */
    getScreenToPDFRatio() {
        if (!this.pageInfo?.pages?.[this.currentPage]) return { x: 1, y: 1 };
        const info = this.pageInfo.pages[this.currentPage];
        const displayWidth = parseFloat(this.pageImg.style.width);
        const displayHeight = parseFloat(this.pageImg.style.height);
        return {
            x: info.width / displayWidth,
            y: info.height / displayHeight,
        };
    }

    /**
     * PDF 座標 → 螢幕座標
     */
    pdfToScreen(x, y) {
        const ratio = this.getScreenToPDFRatio();
        return {
            x: x / ratio.x,
            y: y / ratio.y,
        };
    }

    /**
     * 螢幕座標 → PDF 座標
     */
    screenToPDF(x, y) {
        const ratio = this.getScreenToPDFRatio();
        return {
            x: x * ratio.x,
            y: y * ratio.y,
        };
    }

    /**
     * 刪除當前頁
     */
    async deleteCurrentPage() {
        if (!this.docId || this.pageCount <= 1) {
            showToast('無法刪除：至少需保留一頁', 'error');
            return;
        }

        const pageToDelete = this.currentPage;

        showLoading('刪除頁面中...');
        try {
            const resp = await fetch('/api/delete-pages', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    doc_id: this.docId,
                    pages: [pageToDelete],
                }),
            });
            const data = await readJSON(resp);
            if (data.error) throw new Error(data.error);

            await this.reloadAfterEdit(data);

            hideLoading();
            showToast(`已刪除第 ${pageToDelete + 1} 頁（可按「上一步」救回）`, 'success');
        } catch (e) {
            hideLoading();
            showToast(`刪除失敗: ${e.message}`, 'error');
        }
    }
}

// Global instance
window.pdfViewer = new PDFViewer();
