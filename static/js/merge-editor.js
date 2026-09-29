/**
 * 合併編輯器模組
 * 處理多 PDF 合併、拖拽排序
 */
class MergeEditor {
    constructor() {
        this.mergePanel = document.getElementById('merge-panel');
        this.fileList = document.getElementById('merge-file-list');
        this.mergeUploadZone = document.getElementById('merge-upload-zone');
        this.mergeFileInput = document.getElementById('merge-file-input');

        this.files = []; // [{id, file, filename, pageCount, docId}]
        this.nextId = 0;

        this._bindEvents();
    }

    _bindEvents() {
        // 上傳按鈕
        document.getElementById('merge-add-files').addEventListener('click', () => {
            this.mergeFileInput.click();
        });

        // 把目前正在編輯的檔案（含已做的修改）加進合併清單
        document.getElementById('merge-add-current').addEventListener('click', () => {
            this.addCurrentDoc();
        });

        this.mergeFileInput.addEventListener('change', (e) => {
            this._handleFiles(e.target.files);
            e.target.value = '';
        });

        // 拖放到上傳區
        this.mergeUploadZone.addEventListener('click', () => {
            this.mergeFileInput.click();
        });

        this.mergeUploadZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            this.mergeUploadZone.classList.add('drag-over');
        });

        this.mergeUploadZone.addEventListener('dragleave', () => {
            this.mergeUploadZone.classList.remove('drag-over');
        });

        this.mergeUploadZone.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.mergeUploadZone.classList.remove('drag-over');
            this._handleFiles(e.dataTransfer.files);
        });

        // 整個合併面板都可以接受拖放檔案
        this.mergePanel.addEventListener('dragover', (e) => e.preventDefault());
        this.mergePanel.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (e.dataTransfer.files.length > 0) this._handleFiles(e.dataTransfer.files);
        });

        // 執行合併
        document.getElementById('merge-execute').addEventListener('click', () => {
            this.executeMerge();
        });

        // 關閉：回到編輯模式（上方分頁也一起切回）
        document.getElementById('merge-close').addEventListener('click', () => {
            switchMode('edit');
        });
    }

    /**
     * 顯示合併面板
     */
    show() {
        this.mergePanel.classList.add('visible');
        const viewer = window.pdfViewer;
        const btn = document.getElementById('merge-add-current');
        btn.style.display = viewer.docId && !this.usesDoc(viewer.docId) ? '' : 'none';
    }

    usesDoc(docId) {
        return this.files.some(f => f.docId === docId);
    }

    addCurrentDoc() {
        const viewer = window.pdfViewer;
        if (!viewer.docId || this.usesDoc(viewer.docId)) return;
        this.files.unshift({
            id: this.nextId++,
            file: null,
            filename: `${viewer.filename}（目前編輯中）`,
            pageCount: viewer.pageCount,
            docId: viewer.docId,
        });
        this._renderFileList();
        document.getElementById('merge-add-current').style.display = 'none';
    }

    /**
     * 隱藏合併面板
     */
    hide() {
        this.mergePanel.classList.remove('visible');
    }

    /**
     * 處理上傳的檔案
     */
    async _handleFiles(fileList) {
        for (const file of fileList) {
            if (!file.name.toLowerCase().endsWith('.pdf')) {
                showToast(`跳過非 PDF 檔案: ${file.name}`, 'error');
                continue;
            }

            const id = this.nextId++;

            // 先上傳到後端取得資訊
            showLoading(`載入 ${file.name}...`);
            try {
                const data = await uploadPDF(file);

                this.files.push({
                    id,
                    file,
                    filename: file.name + (data.locked ? '（有密碼）' : ''),
                    pageCount: data.page_count,
                    docId: data.doc_id,
                });

                hideLoading();
            } catch (e) {
                hideLoading();
                if (e.cancelled) showToast(e.message, 'info');
                else showToast(`載入「${file.name}」失敗：${e.message}`, 'error');
            }
        }

        this._renderFileList();
    }

    /**
     * 渲染檔案列表
     */
    _renderFileList() {
        // 保留上傳區域
        this.fileList.innerHTML = '';

        this.files.forEach((item, index) => {
            const el = document.createElement('div');
            el.className = 'merge-file-item';
            el.draggable = true;
            el.dataset.index = index;

            el.innerHTML = `
                <span class="drag-handle" title="按住拖曳調整順序">⠿</span>
                <span class="file-name"></span>
                <span class="page-count">${item.pageCount} 頁</span>
                <button class="remove-btn" title="從清單移除">×</button>
            `;
            el.querySelector('.file-name').textContent = item.filename;

            // 移除按鈕
            el.querySelector('.remove-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                this._removeFile(item.id);
            });

            // 拖拽排序
            el.addEventListener('dragstart', (e) => {
                el.classList.add('dragging');
                e.dataTransfer.setData('text/plain', index.toString());
                e.dataTransfer.effectAllowed = 'move';
            });

            el.addEventListener('dragend', () => {
                el.classList.remove('dragging');
                this._updateOrder();
            });

            el.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                const dragging = this.fileList.querySelector('.dragging');
                if (dragging && dragging !== el) {
                    const rect = el.getBoundingClientRect();
                    const mid = rect.top + rect.height / 2;
                    if (e.clientY < mid) {
                        this.fileList.insertBefore(dragging, el);
                    } else {
                        this.fileList.insertBefore(dragging, el.nextSibling);
                    }
                }
            });

            el.addEventListener('drop', (e) => {
                e.preventDefault();
                e.stopPropagation();
            });

            this.fileList.appendChild(el);
        });

        // 加回上傳區域
        this.fileList.appendChild(this.mergeUploadZone);
    }

    /**
     * 更新排序
     */
    _updateOrder() {
        const items = this.fileList.querySelectorAll('.merge-file-item');
        const newOrder = [];
        items.forEach(item => {
            const idx = parseInt(item.dataset.index);
            newOrder.push(this.files[idx]);
        });
        this.files = newOrder;
        this._renderFileList();
    }

    /**
     * 移除檔案
     */
    _removeFile(id) {
        this.files = this.files.filter(f => f.id !== id);
        this._renderFileList();
        this.show();
    }

    /**
     * 執行合併
     */
    async executeMerge() {
        if (this.files.length < 2) {
            showToast('需要至少 2 個 PDF 才能合併', 'error');
            return;
        }

        showLoading('正在合併 PDF...');

        try {
            const formData = new FormData();
            const config = this.files.map(f => ({
                doc_id: f.docId,
                pages: null, // 全部頁面
            }));
            formData.append('config', JSON.stringify(config));

            const resp = await fetch('/api/merge', {
                method: 'POST',
                body: formData,
            });

            if (!resp.ok) {
                const errData = await readJSON(resp);
                throw new Error(errData.error || '合併失敗');
            }

            // 下載合併後的檔案
            const blob = await resp.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = '合併結果.pdf';
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);

            hideLoading();
            showToast('PDF 合併完成，已開始下載', 'success');
        } catch (e) {
            hideLoading();
            showToast(`合併失敗: ${e.message}`, 'error');
        }
    }

    /**
     * 重置
     */
    reset() {
        this.files = [];
        this._renderFileList();
    }
}

// Global instance
window.mergeEditor = new MergeEditor();
