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
            this.mergeUploadZone.style.borderColor = 'var(--accent-primary)';
        });

        this.mergeUploadZone.addEventListener('dragleave', () => {
            this.mergeUploadZone.style.borderColor = '';
        });

        this.mergeUploadZone.addEventListener('drop', (e) => {
            e.preventDefault();
            this.mergeUploadZone.style.borderColor = '';
            this._handleFiles(e.dataTransfer.files);
        });

        // 執行合併
        document.getElementById('merge-execute').addEventListener('click', () => {
            this.executeMerge();
        });

        // 關閉
        document.getElementById('merge-close').addEventListener('click', () => {
            this.hide();
        });
    }

    /**
     * 顯示合併面板
     */
    show() {
        this.mergePanel.classList.add('visible');
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
                const formData = new FormData();
                formData.append('file', file);
                const resp = await fetch('/api/upload', { method: 'POST', body: formData });
                const data = await resp.json();
                if (data.error) throw new Error(data.error);

                this.files.push({
                    id,
                    file,
                    filename: file.name,
                    pageCount: data.page_count,
                    docId: data.doc_id,
                });

                hideLoading();
            } catch (e) {
                hideLoading();
                showToast(`載入 ${file.name} 失敗: ${e.message}`, 'error');
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
                <span class="drag-handle">⠿</span>
                <span style="font-size:24px;">📄</span>
                <span class="file-name">${item.filename}</span>
                <span class="page-count">${item.pageCount} 頁</span>
                <button class="remove-btn" data-id="${item.id}">✕</button>
            `;

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
                // 更新順序
                this._updateOrder();
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
                const errData = await resp.json();
                throw new Error(errData.error || '合併失敗');
            }

            // 下載合併後的檔案
            const blob = await resp.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'merged.pdf';
            a.click();
            URL.revokeObjectURL(url);

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
