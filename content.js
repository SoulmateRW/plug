// 图提取 ImageGrab - 内容脚本
// 职责：在商品详情页注入悬浮按钮，扫描页面图片（兼容懒加载 / 背景图），去重后交给 background
(() => {
    const BTN_ID = 'image-grab-btn';
    const TOAST_ID = 'image-grab-toast';

    // 懒加载的真实地址常见属性，优先级从高到低
    const LAZY_ATTRS = [
        'data-src', 'data-lazy-src', 'data-original', 'data-original-src',
        'data-ks-lazyload', 'data-lazyload', 'data-lazy', 'data-echo',
        'data-image', 'data-src-large', 'data-url'
    ];

    // 占位图 / 埋点图特征，命中直接跳过
    const SKIP_PATTERN = /(?:^data:|^blob:|^about:|1x1\.(?:gif|png)|spacer\.(?:gif|png)|blank\.(?:gif|png)|loading\.(?:gif|png)|transparent\.(?:gif|png))/i;

    // 视为商品图的最小边长（自然尺寸或布局尺寸，满足其一即可）
    const MIN_SIZE = 100;
    // 计算样式扫描的元素上限，避免在超长详情页上卡顿
    const STYLE_SCAN_LIMIT = 3000;
    const BG_URL_PATTERN = /url\((['"]?)([^'")]+)\1\)/gi;

    // 同一张图的尺寸后缀，用于去重（如 _400x400.jpg、_.webp）
    const SIZE_SUFFIX_PATTERN = /_\d+x\d+(?:q\d+)?(?=\.[a-z0-9]+$)|_\.[a-z0-9]+$/i;

    if (document.getElementById(BTN_ID)) return; // 防止重复注入

    // ---------- URL 处理 ----------

    function toAbsoluteUrl(raw) {
        if (!raw) return null;
        const value = String(raw).trim().replace(/^['"]|['"]$/g, '');
        if (!value || SKIP_PATTERN.test(value)) return null;

        let url;
        try {
            url = new URL(value.startsWith('//') ? location.protocol + value : value, location.href);
        } catch (e) {
            return null;
        }
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

        url.hash = '';
        return url.href;
    }

    // 只用于判重，不用于下载，因此可以丢掉查询参数与尺寸后缀
    function dedupeKey(url) {
        const parsed = new URL(url);
        return parsed.host + parsed.pathname.replace(SIZE_SUFFIX_PATTERN, '');
    }

    // 尺寸越大越优先（_800x800 优于 _400x400），拿不到尺寸信息的记为 0
    function sizeScore(url) {
        const match = url.match(/_(\d+)x(\d+)/);
        if (!match) return 0;
        return Number(match[1]) * Number(match[2]);
    }

    // ---------- 采集 ----------

    function createCollector() {
        const found = new Map();

        return {
            consider(rawUrl) {
                const url = toAbsoluteUrl(rawUrl);
                if (!url) return;

                let key;
                try {
                    key = dedupeKey(url);
                } catch (e) {
                    key = url;
                }

                const size = sizeScore(url);
                const previous = found.get(key);
                if (!previous || size > previous.size) found.set(key, { url, size });
            },
            result() {
                return Array.from(found.values()).map(item => item.url);
            }
        };
    }

    function srcsetBestUrl(value) {
        let best = null;
        String(value).split(',').forEach(part => {
            const [url, descriptor] = part.trim().split(/\s+/);
            if (!url) return;
            const width = descriptor && descriptor.endsWith('w') ? parseInt(descriptor, 10) : 0;
            if (!best || width > best.width) best = { url, width: width || 0 };
        });
        return best ? best.url : null;
    }

    function isTooSmallByLayout(img) {
        const natural = img.naturalWidth || 0;
        const layout = img.width || 0;
        if (natural === 0 && layout === 0) return true; // 未加载且无布局盒，交由懒加载属性兜底
        return natural < MIN_SIZE && layout < MIN_SIZE;
    }

    function isTrackingPixel(img) {
        const natural = img.naturalWidth || 0;
        return natural > 0 && natural <= 4;
    }

    function collectFromImages(collector) {
        document.querySelectorAll('img').forEach(img => {
            let hasLazySource = false;

            const srcset = img.getAttribute('srcset') || img.getAttribute('data-srcset');
            if (srcset) {
                const best = srcsetBestUrl(srcset);
                if (best) {
                    collector.consider(best);
                    hasLazySource = true;
                }
            }

            LAZY_ATTRS.forEach(attr => {
                const value = img.getAttribute(attr);
                if (!value) return;
                hasLazySource = true;
                collector.consider(value);
            });

            if (isTrackingPixel(img)) return;

            const current = img.currentSrc || img.src;
            if (!current) return;
            // 已经有真实懒加载地址时，src 可能是占位图，但仍值得收集：判重会保留分辨率最高的一张
            if (!hasLazySource && isTooSmallByLayout(img)) return;
            collector.consider(current);
        });
    }

    function collectFromBackgrounds(collector) {
        const extract = value => {
            BG_URL_PATTERN.lastIndex = 0;
            let match;
            while ((match = BG_URL_PATTERN.exec(value)) !== null) collector.consider(match[2]);
        };

        // 1) 内联 style 上的背景图（详情页图文常这么写），成本极低
        document.querySelectorAll('[style]').forEach(el => {
            const style = el.getAttribute('style');
            if (style && style.indexOf('background') !== -1) extract(style);
        });

        // 2) 样式表里定义的背景图，只在有上限的节点集合上读取计算样式
        const nodes = document.querySelectorAll('div, section, figure, a, li, span');
        const limit = Math.min(nodes.length, STYLE_SCAN_LIMIT);
        for (let i = 0; i < limit; i++) {
            const backgroundImage = getComputedStyle(nodes[i]).backgroundImage;
            if (backgroundImage && backgroundImage !== 'none') extract(backgroundImage);
        }
    }

    function collectImages() {
        const collector = createCollector();
        collectFromImages(collector);
        collectFromBackgrounds(collector);
        return collector.result();
    }

    // ---------- 界面 ----------

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = BTN_ID;
    btn.innerText = '获取图片';
    btn.addEventListener('click', grab);
    (document.body || document.documentElement).appendChild(btn);

    function showToast(message, duration = 4000) {
        const existing = document.getElementById(TOAST_ID);
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.id = TOAST_ID;
        toast.innerText = message;
        (document.body || document.documentElement).appendChild(toast);

        setTimeout(() => toast.remove(), duration);
    }

    function grab() {
        const images = collectImages();

        if (images.length === 0) {
            showToast('没有找到图片。先滚动页面让图片加载出来，再试一次。');
            return;
        }

        btn.disabled = true;
        btn.innerText = '提取中...';

        chrome.runtime.sendMessage({ action: 'showImages', data: images }, response => {
            const error = chrome.runtime.lastError;
            btn.disabled = false;
            btn.innerText = '获取图片';

            if (error) {
                showToast(`提取失败：${error.message}`);
                return;
            }
            if (!response || !response.ok) {
                showToast(`提取失败：${(response && response.error) || '未知错误'}`);
            }
        });
    }

    // 工具栏图标点击 -> background 转发过来
    chrome.runtime.onMessage.addListener(request => {
        if (request && request.action === 'triggerGrab') grab();
    });
})();
