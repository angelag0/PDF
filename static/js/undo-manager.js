/**
 * Undo/Redo 管理器
 * 維護操作歷史堆疊，支援 Ctrl+Z / Ctrl+Y
 */
class UndoManager {
    constructor(maxSteps = 50) {
        this.undoStack = [];
        this.redoStack = [];
        this.maxSteps = maxSteps;
        this.onStateChange = null; // callback when undo/redo state changes
    }

    /**
     * 記錄一個操作
     * @param {Object} action - {type, data, undo(), redo()}
     */
    push(action) {
        this.undoStack.push(action);
        this.redoStack = []; // 新操作清空 redo
        
        // 限制堆疊大小
        if (this.undoStack.length > this.maxSteps) {
            this.undoStack.shift();
        }

        this._notifyChange();
    }

    /**
     * 撤銷上一個操作
     */
    async undo() {
        if (this.undoStack.length === 0) return false;

        const action = this.undoStack.pop();
        try {
            await action.undo();
            this.redoStack.push(action);
            this._notifyChange();
            return true;
        } catch (e) {
            console.error('Undo failed:', e);
            this.undoStack.push(action); // 失敗時恢復
            return false;
        }
    }

    /**
     * 重做上一個撤銷的操作
     */
    async redo() {
        if (this.redoStack.length === 0) return false;

        const action = this.redoStack.pop();
        try {
            await action.redo();
            this.undoStack.push(action);
            this._notifyChange();
            return true;
        } catch (e) {
            console.error('Redo failed:', e);
            this.redoStack.push(action);
            return false;
        }
    }

    canUndo() {
        return this.undoStack.length > 0;
    }

    canRedo() {
        return this.redoStack.length > 0;
    }

    clear() {
        this.undoStack = [];
        this.redoStack = [];
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
