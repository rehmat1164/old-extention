function openFolderDb() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('autoMetaCopyFileSystem', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('handles');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function saveDirectoryHandle(handle) {
    const db = await openFolderDb();
    await new Promise((resolve, reject) => {
        const tx = db.transaction('handles', 'readwrite');
        tx.objectStore('handles').put(handle, 'downloadDirectory');
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
    });
    db.close();
}

const chooseBtn = document.getElementById('chooseBtn');
const statusEl = document.getElementById('status');

chooseBtn.addEventListener('click', async () => {
    try {
        if (!window.showDirectoryPicker) {
            statusEl.textContent = 'Folder picker is not supported in this Chrome context.';
            return;
        }
        const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
        await saveDirectoryHandle(handle);
        await chrome.storage.local.set({
            downloadFolder: handle.name || 'Selected Folder',
            useNativeSaveFolder: true
        });
        statusEl.textContent = `Saved folder: ${handle.name || 'Selected Folder'}`;
        setTimeout(() => window.close(), 900);
    } catch (e) {
        statusEl.textContent = `Folder was not selected: ${e.message}`;
    }
});
