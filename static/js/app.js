/**
 * PDF 編輯器 — 主應用邏輯
 * 初始化所有模組、綁定事件、協調模組間交互
 */

// ========================
// Utility Functions
// ========================

function showToast(message, type = 'info') {
    // 連不上伺服器時瀏覽器只會給英文 "Failed to fetch"
    message = String(message).replace(/Failed to fetch|NetworkError[^:]*/i,
        '連不上 PDF 編輯器，請確認黑色視窗還開著（關掉了就重新雙擊啟動檔）');
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    toast.textContent = message;

    container.appendChild(toast);

    // 錯誤訊息多留一點時間讓人看完
    setTimeout(() => {
        toast.style.animation = 'slideOut 0.3s ease-out forwards';
        setTimeout(() => toast.remove(), 300);
    }, type === 'error' ? 6000 : 3500);
}

function showLoading(text = '處理中...') {
    document.getElementById('loading-text').textContent = text;
    document.getElementById('loading-overlay').classList.add('visible');
}

function hideLoading() {
    document.getElementById('loading-overlay').classList.remove('visible');
}

function isTypingTarget(el) {
    return !!el?.closest?.('input, textarea, select, [contenteditable="true"]');
}

/**
 * 讀取後端回應。伺服器回的不是 JSON（例如程式已關閉、當機）時，給看得懂的訊息。
 */
async function readJSON(resp) {
    try {
        return await resp.json();
    } catch (e) {
        throw new Error(`伺服器沒有正常回應（代碼 ${resp.status}），請關掉 PDF 編輯器的黑色視窗後重新啟動`);
    }
}

/**
 * 跳出密碼輸入框。回傳輸入的密碼；按取消回傳 null。
 */
function askPassword(filename, wrong) {
    return new Promise((resolve) => {
        const modal = document.getElementById('password-modal');
        const input = document.getElementById('password-input');
        document.getElementById('password-modal-file').textContent = filename;
        document.getElementById('password-modal-error').style.display = wrong ? 'block' : 'none';
        input.value = '';
        modal.classList.add('visible');
        setTimeout(() => input.focus(), 50);

        const done = (value) => {
            modal.classList.remove('visible');
            input.value = '';
            okBtn.removeEventListener('click', onOk);
            cancelBtn.removeEventListener('click', onCancel);
            input.removeEventListener('keydown', onKey);
            resolve(value);
        };
        const okBtn = document.getElementById('password-ok');
        const cancelBtn = document.getElementById('password-cancel');
        const onOk = () => done(input.value);
        const onCancel = () => done(null);
        const onKey = (e) => {
            if (e.key === 'Enter') onOk();
            if (e.key === 'Escape') onCancel();
        };
        okBtn.addEventListener('click', onOk);
        cancelBtn.addEventListener('click', onCancel);
        input.addEventListener('keydown', onKey);
    });
}

/**
 * 跳出選擇框。choices：[{value, label, primary}]；按 Esc 視同選最後一個（取消）。
 */
function askChoice(title, message, choices) {
    return new Promise((resolve) => {
        const modal = document.getElementById('choice-modal');
        const footer = document.getElementById('choice-modal-buttons');
        document.getElementById('choice-modal-title').textContent = title;
        document.getElementById('choice-modal-text').textContent = message;
        footer.innerHTML = '';

        const done = (value) => {
            modal.classList.remove('visible');
            document.removeEventListener('keydown', onKey, true);
            resolve(value);
        };
        const onKey = (e) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                done(choices[choices.length - 1].value);
            }
        };

        choices.forEach(c => {
            const btn = document.createElement('button');
            btn.className = 'btn ' + (c.primary ? 'btn-primary' : 'btn-secondary');
            btn.textContent = c.label;
            btn.addEventListener('click', () => done(c.value));
            footer.appendChild(btn);
        });
        document.addEventListener('keydown', onKey, true);
        modal.classList.add('visible');
    });
}

/**
 * 上傳 PDF；有密碼的檔案會請使用者輸入，輸錯可以重試。
 * 使用者按取消時丟出 cancelled=true 的錯誤。
 */
async function uploadPDF(file) {
    let password = null;
    for (;;) {
        const formData = new FormData();
        formData.append('file', file);
        if (password !== null) formData.append('password', password);

        const resp = await fetch('/api/upload', { method: 'POST', body: formData });
        const data = await readJSON(resp);
        if (data.need_password) {
            hideLoading();
            password = await askPassword(file.name, data.wrong);
            if (password === null) {
                const err = new Error(`沒有輸入密碼，已取消開啟「${file.name}」`);
                err.cancelled = true;
                throw err;
            }
            showLoading(`正在開啟 ${file.name}...`);
            continue;
        }
        if (data.error) throw new Error(data.error);
        return data;
    }
}


// ========================
// App State
// ========================

const appState = {
    currentMode: 'edit',      // 'edit' | 'merge' | 'crop'
    currentTool: 'select',    // 'select' | 'text' | 'image'
};

const TOOL_HINTS = {
    select: '選取：點一下文字或拖曳框選，右側可修改／複製／刪除（按住 Ctrl 可加選）',
    text: '打字：在頁面上點一下就能打字，框在哪字就印在哪｜點別處自動放入｜Ctrl+Enter 完成｜Esc 取消',
    image: '圖片：拖曳移動、拉四角縮放、拉上方圓點旋轉｜Ctrl+V 可直接貼上截圖｜好了按右側「確認合併進 PDF」',
    crop: '裁切：新增紅色切割線並上下拖曳，把這一頁切成數段；點每段中間的按鈕決定保留或移除',
    merge: '合併：加入多個 PDF、拖曳調整順序，按「開始合併」下載結果',
};

function setHint(key) {
    document.getElementById('status-tool').innerHTML = '';
    const span = document.createElement('span');
    span.textContent = TOOL_HINTS[key] || '';
    document.getElementById('status-tool').appendChild(span);
}


// ========================
// Initialization
// ========================

document.addEventListener('DOMContentLoaded', () => {
    initUpload();
    initToolbar();
    initModeSwitch();
    initZoom();
    initKeyboardShortcuts();
    initPaste();
    initUndoRedoUI();
    initPropertyPanelEvents();
    initExportMenu();
    initContextMenu();
    initSidebarToggle();
    setHint('select');

    // 先載入輸入框用的字型，第一次打字時大小、位置就正確
    document.fonts?.load('16px "PDFEditorTC"').catch(() => {});

    const viewer = window.pdfViewer;
    let lastTextKey = null;

    // PDF Viewer callbacks（換頁、縮放、內容變動都會呼叫）
    viewer.onPageChange = (pageNum, width, height) => {
        if (!window.imageEditor.fabricCanvas) {
            window.imageEditor.init(width, height);
        } else {
            window.imageEditor.resize(width, height);
        }

        // 更新文字覆蓋層與正在打字的輸入框
        window.textEditor.updateOverlaySize();

        // 更新裁切覆蓋層
        window.cropEditor.resize();

        // 換頁或內容有變才重新抓文字位置（單純縮放不用，選取也不會被清掉）
        const key = `${viewer.docId}:${pageNum}:${viewer.contentVersion}`;
        if (key !== lastTextKey) {
            lastTextKey = key;
            window.textEditor.loadTextBlocks(viewer.docId, pageNum);
        }
    };

    // 換頁前：打到一半的字放進 PDF、沒合併的圖片問一下、裁切線清掉
    viewer.beforePageChange = async () => {
        if (!(await finishPendingEdits())) return false;
        window.cropEditor.reset();
        return true;
    };

    viewer.onDocLoaded = () => {
        switchMode('edit');
    };

    // 有修改還沒匯出就關分頁，先提醒
    window.addEventListener('beforeunload', (e) => {
        if (window.undoManager.canUndo() || window.textEditor.hasPendingInput() || window.imageEditor.hasPending()) {
            e.preventDefault();
            e.returnValue = '';
        }
    });
});

/**
 * 把「還沒放進 PDF」的東西處理掉：打到一半的字直接放入；畫布上的圖片問使用者。
 * 回傳 false 表示有東西處理失敗，呼叫端應停止接下來的動作。
 */
async function finishPendingEdits() {
    if (!(await window.textEditor.commitPending())) return false;
    if (!(await window.imageEditor.resolvePending())) return false;
    return true;
}


// ========================
// Upload
// ========================

async function openPDF(file) {
    if (!file.name.toLowerCase().endsWith('.pdf')) {
        showToast('請選擇 PDF 檔案', 'error');
        return;
    }
    const viewer = window.pdfViewer;
    if (viewer.docId) {
        const hasChanges = window.undoManager.canUndo() || window.textEditor.hasPendingInput() || window.imageEditor.hasPending();
        if (hasChanges && !confirm(`「${viewer.filename}」的修改還沒匯出，開啟新檔案後這些修改就找不回來了。\n\n確定要開啟「${file.name}」嗎？`)) {
            return;
        }
    }
    await viewer.loadPDF(file);
}

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

    document.getElementById('btn-open').addEventListener('click', () => {
        fileInput.click();
    });

    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            openPDF(e.target.files[0]);
        }
        // 清空，才能再次選同一個檔案
        e.target.value = '';
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
        e.stopPropagation();
        uploadZone.classList.remove('drag-over');
        if (e.dataTransfer.files.length > 0) {
            openPDF(e.dataTransfer.files[0]);
        }
    });

    // 整個 canvas-area 也可以接受拖放：PDF＝開啟，圖片＝放上目前這一頁
    const canvasArea = document.getElementById('canvas-area');
    canvasArea.addEventListener('dragover', (e) => {
        e.preventDefault();
    });
    canvasArea.addEventListener('drop', async (e) => {
        e.preventDefault();
        if (e.dataTransfer.files.length === 0) return;
        const file = e.dataTransfer.files[0];
        if (file.name.toLowerCase().endsWith('.pdf')) {
            openPDF(file);
        } else if (file.type.startsWith('image/')) {
            if (!window.pdfViewer.docId) {
                showToast('請先開啟 PDF，再把圖片拖進來', 'info');
                return;
            }
            if (appState.currentMode !== 'edit') await switchMode('edit');
            if (appState.currentTool !== 'image') await switchTool('image', { openPicker: false });
            if (appState.currentTool === 'image') window.imageEditor.addImageFromFile(file);
        } else {
            showToast('只能拖入 PDF 或圖片檔', 'error');
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
    document.getElementById('btn-delete-page').addEventListener('click', async () => {
        const viewer = window.pdfViewer;
        if (!viewer.docId) {
            showToast('請先開啟 PDF 檔案', 'info');
            return;
        }
        if (!(await finishPendingEdits())) return;
        if (confirm(`確定要刪除第 ${viewer.currentPage + 1} 頁嗎？\n（刪錯了可以按「上一步」救回）`)) {
            viewer.deleteCurrentPage();
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

async function switchTool(tool, options = {}) {
    const viewer = window.pdfViewer;
    if (tool !== 'select' && !viewer.docId) {
        showToast('請先開啟 PDF 檔案', 'info');
        return;
    }

    // 離開打字或圖片工具前，把還沒放進 PDF 的東西處理掉
    const prev = appState.currentTool;
    if (prev === 'text' && tool !== 'text' && !(await window.textEditor.commitPending())) return;
    if (prev === 'image' && tool !== 'image' && !(await window.imageEditor.resolvePending())) return;

    appState.currentTool = tool;
    window.textEditor._clearSelection();

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
            break;
        case 'text':
            window.textEditor.enableTextInputMode();
            document.getElementById('text-properties').style.display = 'block';
            break;
        case 'image':
            window.imageEditor.activate();
            if (options.openPicker !== false) {
                document.getElementById('image-file-input').click();
            }
            break;
    }
    setHint(tool);
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

async function switchMode(mode) {
    if (mode === 'crop' && !window.pdfViewer.docId) {
        showToast('請先開啟 PDF 檔案', 'info');
        return;
    }
    if (!(await finishPendingEdits())) return;

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
            appState.currentTool = null;
            await switchTool('select');
            break;
        case 'merge':
            editTools.style.display = 'none';
            actionTools.style.display = 'none';
            window.mergeEditor.show();
            setHint('merge');
            break;
        case 'crop':
            editTools.style.display = 'none';
            actionTools.style.display = 'flex';
            window.cropEditor.activate();
            setHint('crop');
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
        // 正在輸入框裡打字時，快捷鍵交給輸入框自己處理
        // （否則在右側文字框按 Delete 刪一個字，會把 PDF 上選取的文字整段刪掉）
        if (isTypingTarget(e.target)) return;

        const ctrl = e.ctrlKey || e.metaKey;
        const key = e.key.toLowerCase();
        const viewer = window.pdfViewer;

        // Ctrl+Z: Undo
        if (ctrl && key === 'z' && !e.shiftKey) {
            e.preventDefault();
            window.undoManager.undo();
            return;
        }

        // Ctrl+Y or Ctrl+Shift+Z: Redo
        if (ctrl && (key === 'y' || (e.shiftKey && key === 'z'))) {
            e.preventDefault();
            window.undoManager.redo();
            return;
        }

        // Delete / Backspace: 刪除選中的圖片或文字
        if (e.key === 'Delete' || e.key === 'Backspace') {
            if (appState.currentTool === 'image' && window.imageEditor.deleteSelected()) {
                e.preventDefault();
            } else if (appState.currentMode === 'edit' && appState.currentTool === 'select' && window.textEditor.selectedSpans.length > 0) {
                e.preventDefault();
                window.textEditor.deleteSelectedText();
            }
            return;
        }

        // Ctrl+C: 複製文字
        if (ctrl && key === 'c' && appState.currentTool === 'select' && window.textEditor.selectedSpans.length > 0) {
            window.textEditor.copySelectedText();
            return;
        }

        // Ctrl+A: 全選本頁文字
        if (ctrl && key === 'a' && viewer.docId && appState.currentMode === 'edit' && appState.currentTool === 'select') {
            e.preventDefault();
            window.textEditor.selectAll();
            return;
        }

        // Page Up / Down
        if (e.key === 'PageUp') {
            e.preventDefault();
            viewer.prevPage();
        }
        if (e.key === 'PageDown') {
            e.preventDefault();
            viewer.nextPage();
        }

        // Escape: 取消目前的選取
        if (e.key === 'Escape') {
            window.textEditor.cancelPendingInput();
            window.textEditor._clearSelection();
            window.imageEditor.deselect();
            document.getElementById('context-menu').classList.remove('visible');
            document.getElementById('export-dropdown').classList.remove('open');
        }
    });
}


// ========================
// Paste（任何時候 Ctrl+V 貼上截圖都能放到頁面上）
// ========================

function initPaste() {
    document.addEventListener('paste', async (e) => {
        if (isTypingTarget(e.target)) return;
        if (!window.pdfViewer.docId || appState.currentMode !== 'edit') return;

        const file = ImageEditor.imageFromClipboard(e);
        if (!file) return;
        e.preventDefault();

        if (appState.currentTool !== 'image') await switchTool('image', { openPicker: false });
        if (appState.currentTool === 'image') window.imageEditor.addImageFromFile(file);
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
        document.getElementById('btn-undo').classList.toggle('is-disabled', !canUndo);
        document.getElementById('btn-redo').classList.toggle('is-disabled', !canRedo);
    };
    window.undoManager.clear();
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
        let val = e.target.value.trim();
        if (/^[0-9a-fA-F]{6}$/.test(val)) val = '#' + val;
        if (/^#[0-9a-fA-F]{6}$/.test(val)) {
            const picker = document.getElementById('font-color-input');
            picker.value = val;
            e.target.value = val;
            // 通知正在打的字即時換色
            picker.dispatchEvent(new Event('input'));
        } else {
            e.target.value = document.getElementById('font-color-input').value;
            showToast('顏色請輸入 # 加 6 碼，例如 #FF0000', 'error');
        }
    });

    // Image confirm
    document.getElementById('btn-confirm-image').addEventListener('click', () => {
        window.imageEditor.confirmImages();
    });
    document.getElementById('btn-add-image').addEventListener('click', () => {
        document.getElementById('image-file-input').click();
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
        dropdown.classList.remove('open');
        exportFile('pdf');
    });
    document.getElementById('export-jpg').addEventListener('click', () => {
        dropdown.classList.remove('open');
        exportFile('jpg');
    });
    document.getElementById('export-docx').addEventListener('click', () => {
        dropdown.classList.remove('open');
        exportFile('docx');
    });
}

async function exportFile(format) {
    const viewer = window.pdfViewer;
    if (!viewer.docId) {
        showToast('請先開啟 PDF 檔案', 'error');
        return;
    }

    // 打到一半的字、還沒合併的圖片先處理，匯出的檔案才會是畫面上看到的樣子
    if (!(await finishPendingEdits())) return;

    // 原檔有密碼：問要不要保留（例如只匯出封面給別人，就不想讓對方需要你的身分證字號）
    let query = '';
    if (format === 'pdf' && viewer.locked) {
        const choice = await askChoice(
            '匯出的 PDF 要不要密碼？',
            `「${viewer.filename}」原本有開啟密碼。`,
            [
                { value: 'remove', label: '不要密碼（對方直接打得開）', primary: true },
                { value: 'keep', label: '保留原本的密碼' },
                { value: null, label: '取消' },
            ],
        );
        if (choice === null) return;
        query = choice === 'remove' ? '?keep_password=0' : '';
    }

    const labels = { pdf: 'PDF', jpg: 'JPG 圖片', docx: 'Word' };
    showLoading(format === 'docx' ? '正在轉成 Word，頁數多時需要一點時間...' : `正在匯出 ${labels[format]}...`);

    try {
        const url = `/api/export/${format}/${viewer.docId}${query}`;
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
        let filename = `output.${format === 'jpg' ? 'zip' : format}`;
        if (disposition) {
            const star = disposition.match(/filename\*=UTF-8''([^;\n]+)/i);
            const plain = disposition.match(/filename="?([^";\n]+)"?/i);
            if (star) filename = decodeURIComponent(star[1]);
            else if (plain) filename = plain[1];
        }
        a.download = filename;
        a.click();
        setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);

        hideLoading();
        showToast(`已下載「${filename}」（在瀏覽器的「下載」資料夾）`, 'success');
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
        window.textEditor.selectAll();
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
