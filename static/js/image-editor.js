/**
 * 圖片編輯器模組
 * 處理圖片上傳/貼上、Fabric.js 拖拽/縮放/旋轉、嵌入 PDF
 */
class ImageEditor {
    constructor() {
        this.fabricCanvas = null;
        this.isActive = false;
        this.currentImage = null;
        this.pageNum = null; // 畫布上的圖片屬於哪一頁
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
        this._canvasWidth = width;

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
        this.fabricCanvas?.discardActiveObject();
        this.fabricCanvas?.renderAll();

        document.getElementById('image-properties').style.display = 'none';
    }

    /**
     * 畫布上是否還有沒合併進 PDF 的圖片
     */
    hasPending() {
        return !!this.fabricCanvas && this.fabricCanvas.getObjects('image').length > 0;
    }

    clearAll() {
        if (this.fabricCanvas) {
            this.fabricCanvas.clear();
            this.fabricCanvas.renderAll();
        }
        this.currentImage = null;
        this.pageNum = null;
    }

    /**
     * 離開圖片、換頁、匯出前：問使用者畫布上的圖片要不要放進 PDF。
     * 回傳 true 表示可以繼續。
     */
    async resolvePending() {
        if (!this.hasPending()) return true;
        const n = this.fabricCanvas.getObjects('image').length;
        if (confirm(`頁面上還有 ${n} 張圖片沒有放進 PDF。\n\n按「確定」放進 PDF；按「取消」丟掉這些圖片。`)) {
            return await this.confirmImages();
        }
        this.clearAll();
        return true;
    }

    /**
     * 上傳並添加圖片
     */
    addImageFromFile(file) {
        const reader = new FileReader();
        reader.onload = (e) => {
            this._addImageToCanvas(e.target.result, file.name, file);
        };
        reader.readAsDataURL(file);
    }

    /**
     * 從剪貼簿取出圖片檔（沒有則回傳 null）
     */
    static imageFromClipboard(e) {
        const items = e.clipboardData?.items;
        if (!items) return null;
        for (const item of items) {
            if (item.type.startsWith('image/')) {
                const file = item.getAsFile();
                if (file) return file;
            }
        }
        return null;
    }

    /**
     * 將圖片添加到 Fabric 畫布
     */
    _addImageToCanvas(dataUrl, name = 'image', file = null) {
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
                cornerColor: '#ffffff',
                cornerStrokeColor: '#1d5fb8',
                borderColor: '#1d5fb8',
                transparentCorners: false,
                cornerSize: 9,
                cornerStyle: 'rect',
                // 旋轉到接近直角時自動對齊，放進 PDF 時可直接用原圖
                snapAngle: 90,
                snapThreshold: 8,
                _customName: name,
            });
            // 保留原始檔：放進 PDF 時直接用原圖，不經瀏覽器重畫（重畫會在邊緣留下一圈細框、畫質也會變差）
            img._srcFile = file;

            this.fabricCanvas.add(img);
            this.fabricCanvas.setActiveObject(img);
            this.fabricCanvas.renderAll();

            this.pageNum = window.pdfViewer.currentPage;
            this.currentImage = img;
            this._updatePropertiesPanel(img);

            showToast('圖片已放上頁面：拖曳調整位置與大小，好了按右側「確認合併進 PDF」', 'info');
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
        const r = window.pdfViewer.getScreenToPDFRatio();
        document.getElementById('img-width-input').value =
            Math.round(img.width * img.scaleX * r.x);
        document.getElementById('img-height-input').value =
            Math.round(img.height * img.scaleY * r.y);
        document.getElementById('img-x-input').value = Math.round(img.left * r.x);
        document.getElementById('img-y-input').value = Math.round(img.top * r.y);
    }

    /**
     * 從屬性面板更新物件
     */
    updateFromPanel() {
        if (!this.currentImage) return;

        const r = window.pdfViewer.getScreenToPDFRatio();
        const w = parseFloat(document.getElementById('img-width-input').value) / r.x;
        const h = parseFloat(document.getElementById('img-height-input').value) / r.y;
        const x = parseFloat(document.getElementById('img-x-input').value) / r.x;
        const y = parseFloat(document.getElementById('img-y-input').value) / r.y;
        if ([w, h, x, y].some(v => isNaN(v)) || w <= 0 || h <= 0) return;

        this.currentImage.set({
            left: x,
            top: y,
            scaleX: w / this.currentImage.width,
            scaleY: h / this.currentImage.height,
        });
        this.currentImage.setCoords();

        this.fabricCanvas.renderAll();
    }

    /**
     * 確認並合併圖片到 PDF
     */
    async confirmImages() {
        const viewer = window.pdfViewer;
        if (!this.fabricCanvas || !viewer.docId) return false;

        const objects = this.fabricCanvas.getObjects('image');
        if (objects.length === 0) {
            showToast('頁面上沒有待合併的圖片', 'info');
            return true;
        }

        showLoading('正在合併圖片到 PDF...');
        this.fabricCanvas.discardActiveObject();

        try {
            let data = null;
            for (const [i, img] of objects.entries()) {
                // 旋轉後的外框（畫面座標），輸出的點陣圖也是這個外框大小
                const box = img.getBoundingRect(true, true);
                const pdfTopLeft = viewer.screenToPDF(box.left, box.top);
                const pdfBottomRight = viewer.screenToPDF(box.left + box.width, box.top + box.height);

                // 沒旋轉或轉了直角：直接放原圖，由 PDF 負責旋轉 → 無邊框、原畫質
                // 轉了其他角度：只能由瀏覽器畫成透明底的 PNG（盡量保留解析度，最多放大 4 倍）
                const angle = ((Math.round(img.angle) % 360) + 360) % 360;
                let blob, rotate = 0;
                if (img._srcFile && !img.flipX && !img.flipY && angle % 90 === 0) {
                    blob = img._srcFile;
                    rotate = angle;
                } else {
                    const multiplier = Math.max(1, Math.min(4, 1 / Math.min(img.scaleX, img.scaleY)));
                    const imgDataUrl = img.toDataURL({ format: 'png', multiplier });
                    blob = await (await fetch(imgDataUrl)).blob();
                }

                const formData = new FormData();
                formData.append('doc_id', viewer.docId);
                formData.append('page_num', this.pageNum ?? viewer.currentPage);
                formData.append('rect', JSON.stringify([
                    pdfTopLeft.x, pdfTopLeft.y,
                    pdfBottomRight.x, pdfBottomRight.y,
                ]));
                // 同一次合併的多張圖只存一次快照，按一次「上一步」全部還原
                formData.append('snapshot', i === 0 ? '1' : '0');
                formData.append('rotate', rotate);
                formData.append('image', blob, blob.name || 'image.png');

                const resp = await fetch('/api/image/add', {
                    method: 'POST',
                    body: formData,
                });
                data = await readJSON(resp);
                if (data.error) throw new Error(data.error);
            }

            // 清除畫布上的圖片
            this.clearAll();
            await viewer.reloadAfterEdit(data);

            hideLoading();
            showToast('圖片已合併到 PDF', 'success');
            return true;
        } catch (e) {
            hideLoading();
            showToast(`合併失敗: ${e.message}`, 'error');
            return false;
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
            return true;
        }
        return false;
    }

    deselect() {
        this.fabricCanvas?.discardActiveObject();
        this.fabricCanvas?.renderAll();
    }

    /**
     * 更新畫布大小
     */
    resize(width, height) {
        if (this.fabricCanvas) {
            // 畫面縮放時，畫布上的圖片跟著等比例縮放、移動，才會對得上 PDF 位置
            const factor = this._canvasWidth ? width / this._canvasWidth : 1;
            if (factor !== 1) {
                this.fabricCanvas.getObjects().forEach(obj => {
                    obj.set({
                        left: obj.left * factor,
                        top: obj.top * factor,
                        scaleX: obj.scaleX * factor,
                        scaleY: obj.scaleY * factor,
                    });
                    obj.setCoords();
                });
            }
            this._canvasWidth = width;
            this.fabricCanvas.setDimensions({ width, height });
            this.fabricCanvas.renderAll();
            if (this.currentImage) this._updatePropertiesPanel(this.currentImage);
        }
    }
}

// Global instance
window.imageEditor = new ImageEditor();
