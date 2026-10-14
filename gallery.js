// 图提取 ImageGrab - 图库页
// 职责：展示已提取的图片、勾选，并通过 chrome.downloads 直接下载原始地址
document.addEventListener('DOMContentLoaded', () => {
    const grid = document.getElementById('image-grid');
    const countSpan = document.getElementById('img-count');
    const downloadBtn = document.getElementById('download-btn');
    const emptyState = document.getElementById('empty-state');
    const selectAllBtn = document.getElementById('select-all');
    const inverseSelectBtn = document.getElementById('inverse-select');

    const FILE_PREFIX = '商品图';
    const SEQ_KEY = 'downloadSeq';
    const DOWNLOAD_TIMEOUT = 90000;
    const IMAGE_EXT_PATTERN = /\.(jpe?g|png|gif|webp|bmp|avif|svg)(?=[._!?]|$)/gi;

    let downloading = false;

    // ---------- 工具 ----------

    // 直接下载远程地址：downloads API 不受图库页的跨域限制，也不需要 blob / objectURL
    function downloadOne(url, filename) {
        return new Promise((resolve, reject) => {
            chrome.downloads.download({ url, filename, saveAs: false }, downloadId => {
                const error = chrome.runtime.lastError;
                if (error) {
                    reject(new Error(error.message));
                    return;
                }
                waitForFinish(downloadId).then(resolve, reject);
            });
        });
    }

    // 等待下载真正结束，这样 403 / 防盗链之类的中断能被统计到失败里
    function waitForFinish(downloadId) {
        return new Promise((resolve, reject) => {
            let settled = false;

            const finish = (fn, value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                chrome.downloads.onChanged.removeListener(onChanged);
                fn(value);
            };

            const timer = setTimeout(() => finish(reject, new Error('下载超时')), DOWNLOAD_TIMEOUT);

            function onChanged(delta) {
                if (delta.id !== downloadId || !delta.state) return;
                if (delta.state.current === 'complete') finish(resolve, downloadId);
                else if (delta.state.current === 'interrupted') {
                    const reason = delta.error && delta.error.current;
                    finish(reject, new Error(reason ? `下载中断：${reason}` : '下载中断'));
                }
            }

            chrome.downloads.onChanged.addListener(onChanged);

            // 兜底：若下载在监听器挂上之前就已结束，补查一次状态
            chrome.downloads.search({ id: downloadId }, items => {
                const item = items && items[0];
                if (!item) return;
                if (item.state === 'complete') finish(resolve, downloadId);
                else if (item.state === 'interrupted') {
                    finish(reject, new Error(item.error ? `下载中断：${item.error}` : '下载中断'));
                }
            });
        });
    }

    // 按 URL 推断真实扩展名：文件字节保持原格式，不再谎报 .png
    function guessExtension(url) {
        try {
            const last = new URL(url).pathname.split('/').pop() || '';
            const hits = last.match(IMAGE_EXT_PATTERN);
            if (hits && hits.length > 0) {
                const ext = hits[hits.length - 1].slice(1).toLowerCase();
                return ext === 'jpeg' ? 'jpg' : ext;
            }
        } catch (e) {
            // 地址异常时退回默认值
        }
        return 'jpg';
    }

    function formatStamp(date) {
        const pad = value => String(value).padStart(2, '0');
        return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
    }

    // 编号跨批次连续，避免重复下载时文件名互相覆盖
    function readSeq() {
        return new Promise(resolve => {
            chrome.storage.local.get([SEQ_KEY], result => {
                const value = Number((result || {})[SEQ_KEY]);
                resolve(Number.isFinite(value) && value > 0 ? value : 1);
            });
        });
    }

    function writeSeq(value) {
        return new Promise(resolve => chrome.storage.local.set({ [SEQ_KEY]: value }, resolve));
    }

    function selectedCards() {
        return Array.from(grid.querySelectorAll('.img-card')).filter(card => {
            const checkbox = card.querySelector('input[type="checkbox"]');
            return checkbox && checkbox.checked && !checkbox.disabled;
        });
    }

    function updateDownloadBtn() {
        if (downloading) return;
        const count = selectedCards().length;
        downloadBtn.innerText = `下载选中 (${count})`;
        downloadBtn.disabled = count === 0;
    }

    // ---------- 渲染 ----------

    function createCard(src, index) {
        const card = document.createElement('div');
        card.className = 'img-card';
        card.dataset.src = src;

        const img = document.createElement('img');
        img.src = src;
        img.loading = 'lazy';
        img.referrerPolicy = 'no-referrer';
        img.alt = `商品图 ${index + 1}`;

        const checkboxWrap = document.createElement('div');
        checkboxWrap.className = 'checkbox-container';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.dataset.src = src;
        checkboxWrap.appendChild(checkbox);

        img.addEventListener('error', () => {
            card.classList.add('failed');
            checkbox.checked = false;
            checkbox.disabled = true;
            card.classList.remove('selected');
            updateDownloadBtn();
        });

        card.addEventListener('click', event => {
            if (card.classList.contains('failed')) return;
            if (event.target !== checkbox) checkbox.checked = !checkbox.checked;
            card.classList.toggle('selected', checkbox.checked);
            updateDownloadBtn();
        });

        card.appendChild(img);
        card.appendChild(checkboxWrap);
        return card;
    }

    chrome.storage.local.get(['extractedImages'], result => {
        const images = Array.isArray((result || {}).extractedImages) ? result.extractedImages : [];
        countSpan.innerText = images.length;

        if (images.length === 0) {
            emptyState.hidden = false;
            downloadBtn.disabled = true;
            return;
        }

        images.forEach((src, index) => grid.appendChild(createCard(src, index)));
        updateDownloadBtn();
    });

    // ---------- 批量操作 ----------

    selectAllBtn.addEventListener('click', () => {
        grid.querySelectorAll('.img-card').forEach(card => {
            const checkbox = card.querySelector('input');
            if (!checkbox || checkbox.disabled) return;
            checkbox.checked = true;
            card.classList.add('selected');
        });
        updateDownloadBtn();
    });

    inverseSelectBtn.addEventListener('click', () => {
        grid.querySelectorAll('.img-card').forEach(card => {
            const checkbox = card.querySelector('input');
            if (!checkbox || checkbox.disabled) return;
            checkbox.checked = !checkbox.checked;
            card.classList.toggle('selected', checkbox.checked);
        });
        updateDownloadBtn();
    });

    downloadBtn.addEventListener('click', async () => {
        if (downloading) return;

        const cards = selectedCards();
        if (cards.length === 0) {
            alert('请先选择需要下载的图片！');
            return;
        }

        downloading = true;
        downloadBtn.disabled = true;

        const stamp = formatStamp(new Date());
        let seq = await readSeq();
        let succeeded = 0;
        let failed = 0;

        for (let i = 0; i < cards.length; i++) {
            const src = cards[i].dataset.src;
            const filename = `${FILE_PREFIX}_${stamp}_${String(seq).padStart(4, '0')}.${guessExtension(src)}`;

            downloadBtn.innerText = `正在下载 ${i + 1}/${cards.length}...`;
            try {
                await downloadOne(src, filename);
                succeeded += 1;
                seq += 1;
            } catch (err) {
                failed += 1;
                console.error('下载失败:', src, err);
            }
        }

        await writeSeq(seq);
        downloading = false;

        downloadBtn.innerText = failed > 0
            ? `完成 ${succeeded} 张，失败 ${failed} 张`
            : `已下载 ${succeeded} 张`;

        setTimeout(updateDownloadBtn, 3000);
    });
});
