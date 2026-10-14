// 图提取 ImageGrab - Service Worker
// 职责：接收内容脚本提取到的图片列表 -> 存入 chrome.storage.local -> 打开图库页

const GALLERY_PAGE = 'gallery.html';

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action !== 'showImages') return;

    const images = Array.isArray(request.data) ? request.data : [];

    chrome.storage.local.set({ extractedImages: images }, () => {
        const storageError = chrome.runtime.lastError;
        if (storageError) {
            sendResponse({ ok: false, error: `写入本地存储失败：${storageError.message}` });
            return;
        }

        chrome.tabs.create({ url: GALLERY_PAGE }, () => {
            const tabError = chrome.runtime.lastError;
            if (tabError) {
                sendResponse({ ok: false, error: `打开图库页失败：${tabError.message}` });
                return;
            }
            sendResponse({ ok: true, count: images.length });
        });
    });

    // storage / tabs 都是异步回调，必须返回 true 保持消息通道
    return true;
});

// 点击工具栏图标：通知当前标签页的内容脚本执行一次提取
chrome.action.onClicked.addListener((tab) => {
    if (!tab || typeof tab.id !== 'number') return;

    chrome.tabs.sendMessage(tab.id, { action: 'triggerGrab' }, () => {
        // 页面没有注入内容脚本（非目标站点）时会有 lastError，读取它以消除控制台噪音
        void chrome.runtime.lastError;
    });
});
