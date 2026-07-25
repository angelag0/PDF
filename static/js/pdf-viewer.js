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
    }

    /**
     * 上傳並載入 PDF
     */
    async loadPDF(file) {
        const formData = new FormData();
        formData.append('file', file);

        showLoading('正在載入 PDF...');
        try {
            const resp = await fetch('/api/upload', { method: 'POST', body: formData });
            const data = await resp.json();
            if (data.error) throw new Error(data.error);

            this.docId = data.doc_id;
            this.pageCount = data.page_count;
            this.currentPage = 0;

            // 取得文件資訊
            const infoResp = await fetch(`/api/doc/${this.docId}/info`);
            this.pageInfo = await infoResp.json();

            // 顯示編輯區域
            this.uploadScreen.classList.add('hidden');
            this.canvasContainer.classList.remove('hidden');

            // 更新 UI 資訊
            document.getElementById('info-filename').textContent = data.filename;
            document.getElementById('status-doc').innerHTML = `<span>📄 ${data.filename}</span>`;

            // 載入縮圖
            await this.loadThumbnails();

            // 渲染第一頁
            await this.renderPage(0);

            hideLoading();
            showToast(`成功載入「${data.filename}」（共 ${data.page_count} 頁）`, 'success');

            if (this.onDocLoaded) {
                this.onDocLoaded(this.docId, this.pageCount);
            }
        } catch (e) {
            hideLoading();
            showToast(`載入失敗: ${e.message}`, 'error');
            throw e;
        }
    }

    /**
     * 渲染指定頁面
     */
    async renderPage(pageNum) {
        if (!this.docId || pageNum < 0 || pageNum >= this.pageCount) return;

        this.currentPage = pageNum;
        const url = `/api/page/${this.docId}/${pageNum}?zoom=${this.renderZoom}&t=${Date.now()}`;

        return new Promise((resolve, reject) => {
            this.pageImg.onload = () => {
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
            this.pageImg.onerror = () => reject(new Error('頁面載入失敗'));
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
                this.renderPage(i);
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

    zoomFit() {
        if (!this.docId) return;
        const containerWidth = this.canvasContainer.clientWidth - 48;
        const imgNaturalWidth = this.pageImg.naturalWidth / this.renderZoom;
        this.setZoom(containerWidth / imgNaturalWidth);
    }

    /**
     * 上一頁
     */
    prevPage() {
        if (this.currentPage > 0) {
            this.renderPage(this.currentPage - 1);
        }
    }

    /**
     * 下一頁
     */
    nextPage() {
        if (this.currentPage < this.pageCount - 1) {
            this.renderPage(this.currentPage + 1);
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
            const data = await resp.json();
            if (data.error) throw new Error(data.error);

            this.pageCount = data.page_count;

            // 更新頁面資訊
            const infoResp = await fetch(`/api/doc/${this.docId}/info`);
            this.pageInfo = await infoResp.json();

            // 調整當前頁碼
            if (this.currentPage >= this.pageCount) {
                this.currentPage = this.pageCount - 1;
            }

            await this.loadThumbnails();
            await this.renderPage(this.currentPage);

            hideLoading();
            showToast(`已刪除第 ${pageToDelete + 1} 頁`, 'success');
        } catch (e) {
            hideLoading();
            showToast(`刪除失敗: ${e.message}`, 'error');
        }
    }
}

// Global instance
window.pdfViewer = new PDFViewer();
