/**
 * PDF 編輯器 — 主應用邏輯
 * 初始化所有模組、綁定事件、協調模組間交互
 */

// ========================
// Utility Functions
// ========================

function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    const icon = type === 'success' ? '✅' :
        type === 'error' ? '❌' : 'ℹ️';
    toast.innerHTML = `<span>${icon}</span><span>${message}</span>`;

    container.appendChild(toast);

    setTimeout(() => {
        toast.style.animation = 'slideOut 0.3s ease-out forwards';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

function showLoading(text = '處理中...') {
    document.getElementById('loading-text').textContent = text;
    document.getElementById('loading-overlay').classList.add('visible');
}

function hideLoading() {
    document.getElementById('loading-overlay').classList.remove('visible');
}


// ========================
// App State
// ========================

const appState = {
    currentMode: 'edit',      // 'edit' | 'merge' | 'crop'
    currentTool: 'select',    // 'select' | 'text' | 'image'
};


// ========================
// Initialization
// ========================

document.addEventListener('DOMContentLoaded', () => {
    initUpload();
    initToolbar();
    initModeSwitch();
    initZoom();
    initKeyboardShortcuts();
    initUndoRedoUI();
    initPropertyPanelEvents();
    initExportMenu();
    initContextMenu();
    initSidebarToggle();

    // PDF Viewer callbacks
    window.pdfViewer.onPageChange = (pageNum, width, height) => {
        // 更新 Fabric.js 畫布大小
        window.imageEditor.resize(width, height);
        if (!window.imageEditor.fabricCanvas) {
            window.imageEditor.init(width, height);
        } else {
            window.imageEditor.resize(width, height);
        }

        // 更新文字覆蓋層
        window.textEditor.updateOverlaySize();

        // 更新裁切覆蓋層
        window.cropEditor.resize();

        // 載入文字座標
        window.textEditor.loadTextBlocks(window.pdfViewer.docId, pageNum);
    };

    window.pdfViewer.onDocLoaded = (docId, pageCount) => {
        // 初始化 Fabric canvas
        const wrapper = document.getElementById('pdf-canvas-wrapper');
        const w = parseFloat(wrapper.style.width) || 600;
        const h = parseFloat(wrapper.style.height) || 800;
        window.imageEditor.init(w, h);
    };
});


// ========================
// Upload
// ========================

function initUpload() {
    const uploadZone = document.getElementById('upload-zone');
    const fileInput = document.getElementById('file-input');
    const uploadBtn = document.getElementById('upload-btn');

    uploadBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        fileInput.click();
    });

    uploadZone.addEventListener('click', () => {
        fileInput.click();
    });

    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            window.pdfViewer.loadPDF(e.target.files[0]);
        }
    });

    // Drag & Drop
    uploadZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        uploadZone.classList.add('drag-over');
    });

    uploadZone.addEventListener('dragleave', () => {
        uploadZone.classList.remove('drag-over');
    });

    uploadZone.addEventListener('drop', (e) => {
        e.preventDefault();
        uploadZone.classList.remove('drag-over');
        if (e.dataTransfer.files.length > 0) {
            const file = e.dataTransfer.files[0];
            if (file.name.toLowerCase().endsWith('.pdf')) {
                window.pdfViewer.loadPDF(file);
            } else {
                showToast('請上傳 PDF 檔案', 'error');
            }
        }
    });

    // 整個 canvas-area 也可以接受拖放
    const canvasArea = document.getElementById('canvas-area');
    canvasArea.addEventListener('dragover', (e) => {
        e.preventDefault();
    });
    canvasArea.addEventListener('drop', (e) => {
        e.preventDefault();
        if (e.dataTransfer.files.length > 0) {
            const file = e.dataTransfer.files[0];
            if (file.name.toLowerCase().endsWith('.pdf')) {
                window.pdfViewer.loadPDF(file);
            } else if (file.type.startsWith('image/') && appState.currentTool === 'image') {
                window.imageEditor.addImageFromFile(file);
            }
        }
    });
}


// ========================
// Toolbar
// ========================

function initToolbar() {
    // Edit tools
    document.querySelectorAll('[data-tool]').forEach(btn => {
        btn.addEventListener('click', () => {
            switchTool(btn.dataset.tool);
        });
    });

    // Delete page
    document.getElementById('btn-delete-page').addEventListener('click', () => {
        if (confirm('確定要刪除當前頁面嗎？此操作無法復原。')) {
            window.pdfViewer.deleteCurrentPage();
        }
    });

    // Image upload
    document.getElementById('image-file-input').addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            window.imageEditor.addImageFromFile(e.target.files[0]);
            e.target.value = '';
        }
    });
}

function switchTool(tool) {
    appState.currentTool = tool;

    // Update button states
    document.querySelectorAll('[data-tool]').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tool === tool);
    });

    // Deactivate all
    window.textEditor.disable();
    window.imageEditor.deactivate();

    // Hide all property panels
    document.getElementById('text-properties').style.display = 'none';
    document.getElementById('image-properties').style.display = 'none';
    document.getElementById('selection-info').style.display = 'none';

    // Activate selected tool
    switch (tool) {
        case 'select':
            window.textEditor.enableSelectMode();
            document.getElementById('status-tool').innerHTML = '<span>🔤 選取工具</span>';
            break;
        case 'text':
            window.textEditor.enableTextInputMode();
            document.getElementById('text-properties').style.display = 'block';
            document.getElementById('status-tool').innerHTML = '<span>📝 文字工具</span>';
            break;
        case 'image':
            window.imageEditor.activate();
            // 如果畫布已初始化
            if (!window.imageEditor.fabricCanvas) {
                const wrapper = document.getElementById('pdf-canvas-wrapper');
                const w = parseFloat(wrapper.style.width) || 600;
                const h = parseFloat(wrapper.style.height) || 800;
                window.imageEditor.init(w, h);
            }
            // 自動彈出圖片選擇
            document.getElementById('image-file-input').click();
            document.getElementById('status-tool').innerHTML = '<span>🖼️ 圖片工具</span>';
            break;
    }
}


// ========================
// Mode Switch
// ========================

function initModeSwitch() {
    document.querySelectorAll('.mode-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            switchMode(tab.dataset.mode);
        });
    });
}

function switchMode(mode) {
    appState.currentMode = mode;

    // Update tab states
    document.querySelectorAll('.mode-tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.mode === mode);
    });

    // Show/hide tools
    const editTools = document.getElementById('edit-tools');
    const actionTools = document.getElementById('action-tools');

    // Deactivate everything first
    window.textEditor.disable();
    window.imageEditor.deactivate();
    window.cropEditor.deactivate();
    window.mergeEditor.hide();

    document.getElementById('text-properties').style.display = 'none';
    document.getElementById('image-properties').style.display = 'none';
    document.getElementById('selection-info').style.display = 'none';
    document.getElementById('crop-controls').style.display = 'none';

    switch (mode) {
        case 'edit':
            editTools.style.display = 'flex';
            actionTools.style.display = 'flex';
            switchTool('select');
            break;
        case 'merge':
            editTools.style.display = 'none';
            actionTools.style.display = 'none';
            window.mergeEditor.show();
            break;
        case 'crop':
            editTools.style.display = 'none';
            actionTools.style.display = 'flex';
            window.cropEditor.activate();
            break;
    }
}


// ========================
// Zoom
// ========================

function initZoom() {
    document.getElementById('zoom-in').addEventListener('click', () => {
        window.pdfViewer.zoomIn();
    });
    document.getElementById('zoom-out').addEventListener('click', () => {
        window.pdfViewer.zoomOut();
    });
    document.getElementById('zoom-fit').addEventListener('click', () => {
        window.pdfViewer.zoomFit();
    });

    // 滾輪縮放
    document.getElementById('canvas-container').addEventListener('wheel', (e) => {
        if (e.ctrlKey) {
            e.preventDefault();
            if (e.deltaY < 0) {
                window.pdfViewer.zoomIn();
            } else {
                window.pdfViewer.zoomOut();
            }
        }
    }, { passive: false });
}


// ========================
// Keyboard Shortcuts
// ========================

function initKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
        // Ctrl+Z: Undo
        if (e.ctrlKey && e.key === 'z' && !e.shiftKey) {
            e.preventDefault();
            window.undoManager.undo();
        }

        // Ctrl+Y or Ctrl+Shift+Z: Redo
        if ((e.ctrlKey && e.key === 'y') || (e.ctrlKey && e.shiftKey && e.key === 'z')) {
            e.preventDefault();
            window.undoManager.redo();
        }

        // Delete: 刪除選中文字
        if (e.key === 'Delete' && appState.currentTool === 'select') {
            window.textEditor.deleteSelectedText();
        }

        // Ctrl+C: 複製文字
        if (e.ctrlKey && e.key === 'c' && appState.currentTool === 'select') {
            window.textEditor.copySelectedText();
        }

        // Page Up / Down
        if (e.key === 'PageUp') {
            e.preventDefault();
            window.pdfViewer.prevPage();
        }
        if (e.key === 'PageDown') {
            e.preventDefault();
            window.pdfViewer.nextPage();
        }

        // Escape: 取消當前操作
        if (e.key === 'Escape') {
            window.textEditor._removeTextInputOverlay();
            window.imageEditor.deleteSelected();
            document.getElementById('context-menu').classList.remove('visible');
        }
    });
}


// ========================
// Undo/Redo UI
// ========================

function initUndoRedoUI() {
    document.getElementById('btn-undo').addEventListener('click', () => {
        window.undoManager.undo();
    });
    document.getElementById('btn-redo').addEventListener('click', () => {
        window.undoManager.redo();
    });

    window.undoManager.onStateChange = (canUndo, canRedo) => {
        document.getElementById('btn-undo').style.opacity = canUndo ? '1' : '0.4';
        document.getElementById('btn-redo').style.opacity = canRedo ? '1' : '0.4';
    };
}


// ========================
// Property Panel Events
// ========================

function initPropertyPanelEvents() {
    // Text confirm
    document.getElementById('btn-confirm-text').addEventListener('click', () => {
        window.textEditor.confirmText();
    });

    // Color sync
    document.getElementById('font-color-input').addEventListener('input', (e) => {
        document.getElementById('font-color-hex').value = e.target.value;
    });
    document.getElementById('font-color-hex').addEventListener('change', (e) => {
        const val = e.target.value;
        if (/^#[0-9a-fA-F]{6}$/.test(val)) {
            document.getElementById('font-color-input').value = val;
        }
    });

    // Image confirm
    document.getElementById('btn-confirm-image').addEventListener('click', () => {
        window.imageEditor.confirmImages();
    });

    // Image property inputs
    ['img-width-input', 'img-height-input', 'img-x-input', 'img-y-input'].forEach(id => {
        document.getElementById(id).addEventListener('change', () => {
            window.imageEditor.updateFromPanel();
        });
    });

    // Text actions
    document.getElementById('btn-edit-text').addEventListener('click', () => {
        window.textEditor.updateSelectedText();
    });
    document.getElementById('btn-copy-text').addEventListener('click', () => {
        window.textEditor.copySelectedText();
    });
    document.getElementById('btn-delete-text').addEventListener('click', () => {
        window.textEditor.deleteSelectedText();
    });

    // Crop actions
    document.getElementById('btn-add-cut-line').addEventListener('click', () => {
        window.cropEditor.addCutLine();
    });
    document.getElementById('btn-preview-crop').addEventListener('click', () => {
        window.cropEditor.previewCrop();
    });
    document.getElementById('btn-apply-crop').addEventListener('click', () => {
        window.cropEditor.applyCrop();
    });
}


// ========================
// Export Menu
// ========================

function initExportMenu() {
    const exportBtn = document.getElementById('btn-export');
    const dropdown = document.getElementById('export-dropdown');

    exportBtn.addEventListener('click', () => {
        dropdown.classList.toggle('open');
    });

    // 點擊其他地方關閉
    document.addEventListener('click', (e) => {
        if (!exportBtn.contains(e.target) && !dropdown.contains(e.target)) {
            dropdown.classList.remove('open');
        }
    });

    document.getElementById('export-pdf').addEventListener('click', () => {
        exportFile('pdf');
        dropdown.classList.remove('open');
    });
    document.getElementById('export-jpg').addEventListener('click', () => {
        exportFile('jpg');
        dropdown.classList.remove('open');
    });
    document.getElementById('export-docx').addEventListener('click', () => {
        exportFile('docx');
        dropdown.classList.remove('open');
    });
}

async function exportFile(format) {
    const viewer = window.pdfViewer;
    if (!viewer.docId) {
        showToast('請先載入 PDF', 'error');
        return;
    }

    showLoading(`正在匯出 ${format.toUpperCase()}...`);

    try {
        let url;
        switch (format) {
            case 'pdf':
                url = `/api/export/pdf/${viewer.docId}`;
                break;
            case 'jpg':
                url = `/api/export/jpg/${viewer.docId}`;
                break;
            case 'docx':
                url = `/api/export/docx/${viewer.docId}`;
                break;
        }

        const resp = await fetch(url);
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({ error: '匯出失敗' }));
            throw new Error(err.error);
        }

        const blob = await resp.blob();
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;

        // 取得下載檔名
        const disposition = resp.headers.get('Content-Disposition');
        let filename = `output.${format}`;
        if (disposition) {
            const match = disposition.match(/filename[*]?=(?:UTF-8''|")?([^";\n]+)/i);
            if (match) filename = decodeURIComponent(match[1]);
        }
        a.download = filename;
        a.click();
        URL.revokeObjectURL(blobUrl);

        hideLoading();
        showToast(`${format.toUpperCase()} 匯出成功`, 'success');
    } catch (e) {
        hideLoading();
        showToast(`匯出失敗: ${e.message}`, 'error');
    }
}


// ========================
// Context Menu
// ========================

function initContextMenu() {
    document.getElementById('ctx-copy').addEventListener('click', () => {
        window.textEditor.copySelectedText();
    });
    document.getElementById('ctx-delete').addEventListener('click', () => {
        window.textEditor.deleteSelectedText();
    });
    document.getElementById('ctx-select-all').addEventListener('click', () => {
        // 全選所有文字
        const spans = document.querySelectorAll('.text-span-overlay');
        spans.forEach((span, index) => {
            span.classList.add('selected');
            if (!window.textEditor.selectedSpans.includes(index)) {
                window.textEditor.selectedSpans.push(index);
            }
        });
        window.textEditor._updateSelectionUI();
    });

    // 點擊空白處關閉
    document.addEventListener('click', () => {
        document.getElementById('context-menu').classList.remove('visible');
    });
}


// ========================
// Sidebar Toggle
// ========================

function initSidebarToggle() {
    document.getElementById('toggle-sidebar').addEventListener('click', () => {
        const sidebar = document.getElementById('sidebar');
        sidebar.classList.toggle('collapsed');
        const btn = document.getElementById('toggle-sidebar');
        btn.textContent = sidebar.classList.contains('collapsed') ? '▶' : '◀';
    });
}
