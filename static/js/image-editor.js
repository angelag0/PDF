/**
 * 圖片編輯器模組
 * 處理圖片上傳/貼上、Fabric.js 拖拽/縮放/旋轉、嵌入 PDF
 */
class ImageEditor {
    constructor() {
        this.fabricCanvas = null;
        this.isActive = false;
        this.currentImage = null;
        this._pasteHandler = null;
    }

    /**
     * 初始化 Fabric.js 畫布
     */
    init(width, height) {
        const wrapper = document.getElementById('fabric-canvas-wrapper');
        const canvasEl = document.getElementById('fabric-canvas');

        canvasEl.width = width;
        canvasEl.height = height;

        if (this.fabricCanvas) {
            this.fabricCanvas.dispose();
        }

        this.fabricCanvas = new fabric.Canvas('fabric-canvas', {
            width: width,
            height: height,
            selection: true,
            backgroundColor: 'transparent',
        });

        // 監聽物件選取以更新屬性面板
        this.fabricCanvas.on('selection:created', (e) => this._onSelect(e));
        this.fabricCanvas.on('selection:updated', (e) => this._onSelect(e));
        this.fabricCanvas.on('selection:cleared', () => this._onDeselect());
        this.fabricCanvas.on('object:modified', (e) => this._onObjectModified(e));
        this.fabricCanvas.on('object:scaling', (e) => this._onObjectScaling(e));
    }

    /**
     * 啟用圖片模式
     */
    activate() {
        this.isActive = true;
        const wrapper = document.getElementById('fabric-canvas-wrapper');
        wrapper.classList.add('editing');

        // 監聽剪貼簿貼上
        this._pasteHandler = (e) => this._handlePaste(e);
        document.addEventListener('paste', this._pasteHandler);

        // 顯示圖片屬性面板
        document.getElementById('image-properties').style.display = 'block';
    }

    /**
     * 停用圖片模式
     */
    deactivate() {
        this.isActive = false;
        const wrapper = document.getElementById('fabric-canvas-wrapper');
        wrapper.classList.remove('editing');

        if (this._pasteHandler) {
            document.removeEventListener('paste', this._pasteHandler);
            this._pasteHandler = null;
        }

        document.getElementById('image-properties').style.display = 'none';
    }

    /**
     * 上傳並添加圖片
     */
    addImageFromFile(file) {
        const reader = new FileReader();
        reader.onload = (e) => {
            this._addImageToCanvas(e.target.result, file.name);
        };
        reader.readAsDataURL(file);
    }

    /**
     * 從剪貼簿貼上圖片
     */
    _handlePaste(e) {
        if (!this.isActive) return;

        const items = e.clipboardData?.items;
        if (!items) return;

        for (const item of items) {
            if (item.type.startsWith('image/')) {
                const file = item.getAsFile();
                if (file) {
                    this.addImageFromFile(file);
                    e.preventDefault();
                    return;
                }
            }
        }
    }

    /**
     * 將圖片添加到 Fabric 畫布
     */
    _addImageToCanvas(dataUrl, name = 'image') {
        fabric.Image.fromURL(dataUrl, (img) => {
            // 限制初始大小不超過畫布的 60%
            const canvasW = this.fabricCanvas.width;
            const canvasH = this.fabricCanvas.height;
            const maxW = canvasW * 0.6;
            const maxH = canvasH * 0.6;

            let scale = 1;
            if (img.width > maxW || img.height > maxH) {
                scale = Math.min(maxW / img.width, maxH / img.height);
            }

            img.set({
                left: canvasW / 2 - (img.width * scale) / 2,
                top: canvasH / 2 - (img.height * scale) / 2,
                scaleX: scale,
                scaleY: scale,
                cornerColor: '#6366f1',
                cornerStrokeColor: '#6366f1',
                borderColor: '#6366f1',
                transparentCorners: false,
                cornerSize: 10,
                cornerStyle: 'circle',
                _customName: name,
            });

            this.fabricCanvas.add(img);
            this.fabricCanvas.setActiveObject(img);
            this.fabricCanvas.renderAll();

            this.currentImage = img;
            this._updatePropertiesPanel(img);

            showToast(`已添加圖片: ${name}`, 'success');
        });
    }

    /**
     * 選取物件事件
     */
    _onSelect(e) {
        const obj = e.selected?.[0];
        if (obj && obj.type === 'image') {
            this.currentImage = obj;
            this._updatePropertiesPanel(obj);
            document.getElementById('image-properties').style.display = 'block';
        }
    }

    /**
     * 取消選取
     */
    _onDeselect() {
        this.currentImage = null;
    }

    /**
     * 物件修改完成
     */
    _onObjectModified(e) {
        if (e.target && e.target.type === 'image') {
            this._updatePropertiesPanel(e.target);
        }
    }

    /**
     * 物件縮放中
     */
    _onObjectScaling(e) {
        if (e.target && e.target.type === 'image') {
            this._updatePropertiesPanel(e.target);
        }
    }

    /**
     * 更新屬性面板
     */
    _updatePropertiesPanel(img) {
        document.getElementById('img-width-input').value =
            Math.round(img.width * img.scaleX);
        document.getElementById('img-height-input').value =
            Math.round(img.height * img.scaleY);
        document.getElementById('img-x-input').value = Math.round(img.left);
        document.getElementById('img-y-input').value = Math.round(img.top);
    }

    /**
     * 從屬性面板更新物件
     */
    updateFromPanel() {
        if (!this.currentImage) return;

        const w = parseInt(document.getElementById('img-width-input').value);
        const h = parseInt(document.getElementById('img-height-input').value);
        const x = parseInt(document.getElementById('img-x-input').value);
        const y = parseInt(document.getElementById('img-y-input').value);

        this.currentImage.set({
            left: x,
            top: y,
            scaleX: w / this.currentImage.width,
            scaleY: h / this.currentImage.height,
        });

        this.fabricCanvas.renderAll();
    }

    /**
     * 確認並合併圖片到 PDF
     */
    async confirmImages() {
        const viewer = window.pdfViewer;
        if (!this.fabricCanvas || !viewer.docId) return;

        const objects = this.fabricCanvas.getObjects('image');
        if (objects.length === 0) {
            showToast('畫布上沒有圖片', 'info');
            return;
        }

        showLoading('正在合併圖片到 PDF...');

        try {
            for (const img of objects) {
                // 取得圖片在畫布上的位置和大小
                const screenX = img.left;
                const screenY = img.top;
                const screenW = img.width * img.scaleX;
                const screenH = img.height * img.scaleY;

                // 轉換為 PDF 座標
                const pdfTopLeft = viewer.screenToPDF(screenX, screenY);
                const pdfBottomRight = viewer.screenToPDF(
                    screenX + screenW,
                    screenY + screenH
                );

                // 取得圖片原始資料
                const imgDataUrl = img.toDataURL({ format: 'png' });
                const blob = await (await fetch(imgDataUrl)).blob();

                // 上傳圖片到後端
                const formData = new FormData();
                formData.append('doc_id', viewer.docId);
                formData.append('page_num', viewer.currentPage);
                formData.append('rect', JSON.stringify([
                    pdfTopLeft.x, pdfTopLeft.y,
                    pdfBottomRight.x, pdfBottomRight.y,
                ]));
                formData.append('image', blob, 'image.png');

                const resp = await fetch('/api/image/add', {
                    method: 'POST',
                    body: formData,
                });
                const data = await resp.json();
                if (data.error) throw new Error(data.error);
            }

            // 清除畫布上的圖片
            this.fabricCanvas.clear();
            this.fabricCanvas.renderAll();

            // 刷新頁面
            await viewer.refreshCurrentPage();
            await viewer.refreshThumbnails();

            hideLoading();
            showToast('圖片已合併到 PDF', 'success');
        } catch (e) {
            hideLoading();
            showToast(`合併失敗: ${e.message}`, 'error');
        }
    }

    /**
     * 刪除選中的圖片
     */
    deleteSelected() {
        const activeObj = this.fabricCanvas?.getActiveObject();
        if (activeObj) {
            this.fabricCanvas.remove(activeObj);
            this.fabricCanvas.renderAll();
            this.currentImage = null;
            showToast('圖片已移除', 'info');
        }
    }

    /**
     * 更新畫布大小
     */
    resize(width, height) {
        if (this.fabricCanvas) {
            this.fabricCanvas.setDimensions({ width, height });
            this.fabricCanvas.renderAll();
        }
    }
}

// Global instance
window.imageEditor = new ImageEditor();
