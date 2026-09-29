/**
 * Undo/Redo 管理器
 * 每次修改前，後端會把整份文件存一份快照；上一步／下一步就是換回快照，
 * 所以任何操作（加字、改字、刪字、圖片、刪頁、裁切）都能完整還原，不會在頁面上留下白塊。
 * 這裡只負責呼叫後端、更新按鈕狀態、重新顯示頁面。
 */
class UndoManager {
    constructor() {
        this.canUndoFlag = false;
        this.canRedoFlag = false;
        this.busy = false;
        this.onStateChange = null; // callback when undo/redo state changes
    }

    /**
     * 用後端回傳的 {can_undo, can_redo} 更新狀態
     */
    sync(state) {
        if (!state) return;
        this.canUndoFlag = !!state.can_undo;
        this.canRedoFlag = !!state.can_redo;
        this._notifyChange();
    }

    async undo() {
        return this._run('undo');
    }

    async redo() {
        return this._run('redo');
    }

    async _run(action) {
        const viewer = window.pdfViewer;
        if (!viewer.docId || this.busy) return false;

        // 還在打字（尚未放進 PDF）時，「上一步」＝取消這段輸入
        if (action === 'undo' && window.textEditor.hasPendingInput()) {
            window.textEditor.cancelPendingInput();
            return true;
        }
        if (action === 'undo' ? !this.canUndoFlag : !this.canRedoFlag) {
            showToast(action === 'undo' ? '沒有可以復原的步驟' : '沒有可以重做的步驟', 'info');
            return false;
        }

        this.busy = true;
        try {
            const resp = await fetch(`/api/${action}/${viewer.docId}`, { method: 'POST' });
            const data = await readJSON(resp);
            if (data.error) throw new Error(data.error);
            await viewer.reloadAfterEdit(data);
            showToast(action === 'undo' ? '已復原上一步' : '已重做', 'info');
            return true;
        } catch (e) {
            showToast(`${action === 'undo' ? '復原' : '重做'}失敗: ${e.message}`, 'error');
            return false;
        } finally {
            this.busy = false;
        }
    }

    canUndo() {
        return this.canUndoFlag;
    }

    canRedo() {
        return this.canRedoFlag;
    }

    clear() {
        this.canUndoFlag = false;
        this.canRedoFlag = false;
        this._notifyChange();
    }

    _notifyChange() {
        if (this.onStateChange) {
            this.onStateChange(this.canUndo(), this.canRedo());
        }
    }
}

// Global instance
window.undoManager = new UndoManager();
