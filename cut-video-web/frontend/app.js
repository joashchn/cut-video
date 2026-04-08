/**
 * ASR 词级视频剪辑 - 前端逻辑
 */

// 全局状态
const state = {
    videoId: null,
    filename: null,
    duration: 0,
    sentences: [],
    history: [],  // 撤销历史
    currentTimeUpdate: null,
};

// DOM 元素
const elements = {
    // 上传
    uploadSection: document.getElementById('upload-section'),
    dropZone: document.getElementById('drop-zone'),
    fileInput: document.getElementById('file-input'),
    browseLink: document.getElementById('browse-link'),

    // 加载
    loadingSection: document.getElementById('loading-section'),
    loadingText: document.getElementById('loading-text'),

    // 编辑
    editSection: document.getElementById('edit-section'),
    videoPlayer: document.getElementById('video-player'),
    videoFilename: document.getElementById('video-filename'),
    videoDuration: document.getElementById('video-duration'),
    subtitleList: document.getElementById('subtitle-list'),
    btnUndo: document.getElementById('btn-undo'),
    btnReset: document.getElementById('btn-reset'),
    btnExport: document.getElementById('btn-export'),
    deletedCount: document.getElementById('deleted-count'),

    // 结果
    resultSection: document.getElementById('result-section'),
    resultFilename: document.getElementById('result-filename'),
    btnDownload: document.getElementById('btn-download'),
    btnNew: document.getElementById('btn-new'),
    downloadFrame: document.getElementById('download-frame'),
};

// ========== 上传功能 ==========

function initUpload() {
    // 点击浏览
    elements.browseLink.addEventListener('click', (e) => {
        e.preventDefault();
        elements.fileInput.click();
    });

    // 文件选择
    elements.fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            handleFile(e.target.files[0]);
        }
    });

    // 拖拽
    elements.dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        elements.dropZone.classList.add('dragover');
    });

    elements.dropZone.addEventListener('dragleave', () => {
        elements.dropZone.classList.remove('dragover');
    });

    elements.dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        elements.dropZone.classList.remove('dragover');
        if (e.dataTransfer.files.length > 0) {
            handleFile(e.dataTransfer.files[0]);
        }
    });
}

async function handleFile(file) {
    if (!file.type.startsWith('video/')) {
        alert('请选择视频文件');
        return;
    }

    showSection('loading');
    updateLoadingText('正在上传视频...');

    const formData = new FormData();
    formData.append('file', file);

    try {
        const response = await fetch('/api/upload', {
            method: 'POST',
            body: formData,
        });

        if (!response.ok) {
            throw new Error('上传失败');
        }

        const data = await response.json();
        state.videoId = data.video_id;
        state.filename = data.filename;

        updateLoadingText('视频上传完成，正在进行 ASR 转写（v1 + 热词）...');

        // 开始轮询状态
        pollStatus();

    } catch (error) {
        alert('上传失败: ' + error.message);
        showSection('upload');
    }
}

async function pollStatus() {
    const maxPolls = 300;  // 最多 5 分钟（每 1 秒一次）
    let polls = 0;

    const poll = async () => {
        if (polls++ > maxPolls) {
            alert('转写超时，请重试');
            showSection('upload');
            return;
        }

        try {
            const response = await fetch(`/api/status/${state.videoId}`);
            const data = await response.json();

            if (data.status === 'done') {
                // 转写完成，加载数据
                await loadTranscription();
            } else if (data.status === 'error') {
                alert('转写失败: ' + data.error);
                showSection('upload');
            } else {
                // 继续轮询
                setTimeout(poll, 1000);
            }
        } catch (error) {
            console.error('轮询状态失败:', error);
            setTimeout(poll, 1000);
        }
    };

    poll();
}

async function loadTranscription() {
    updateLoadingText('正在加载转写结果...');

    try {
        const response = await fetch(`/api/timestamps/${state.videoId}`);
        const data = await response.json();

        state.sentences = data.sentences;
        state.duration = data.duration;

        // 加载视频
        elements.videoPlayer.src = `/api/video/${state.videoId}`;

        // 渲染字幕
        renderSubtitles();

        // 显示编辑界面
        showSection('edit');
        updateDeletedCount();

    } catch (error) {
        alert('加载转写结果失败: ' + error.message);
        showSection('upload');
    }
}

// ========== 字幕渲染 ==========

function renderSubtitles() {
    elements.subtitleList.innerHTML = '';

    let wordIndex = 0;

    state.sentences.forEach((sentence, sentenceIdx) => {
        const block = document.createElement('div');
        block.className = 'sentence-block';

        // 时间显示
        const timeSpan = document.createElement('div');
        timeSpan.className = 'sentence-time';
        timeSpan.textContent = formatTime(sentence.begin_time / 1000) + ' → ' + formatTime(sentence.end_time / 1000);
        block.appendChild(timeSpan);

        // 词
        const wordsDiv = document.createElement('div');
        wordsDiv.className = 'sentence-words';

        sentence.words.forEach((word) => {
            const wordSpan = document.createElement('span');
            wordSpan.className = 'word';
            wordSpan.textContent = word.text;
            wordSpan.dataset.globalIndex = wordIndex++;

            // 恢复删除状态
            if (word.deleted) {
                wordSpan.classList.add('deleted');
            }

            // 点击切换删除状态
            wordSpan.addEventListener('click', () => toggleWord(wordIdx - 1, sentenceIdx, wordSpan));

            // 鼠标悬停同步视频时间
            wordSpan.addEventListener('mouseenter', () => {
                elements.videoPlayer.currentTime = word.begin_time / 1000;
            });

            wordsDiv.appendChild(wordSpan);
        });

        block.appendChild(wordsDiv);
        elements.subtitleList.appendChild(block);
    });

    // 视频时间更新时高亮当前词
    elements.videoPlayer.addEventListener('timeupdate', highlightCurrentWord);
}

function toggleWord(globalIdx, sentenceIdx, wordSpan) {
    // 保存历史（用于撤销）
    saveHistory();

    // 切换状态
    const sentence = state.sentences[sentenceIdx];
    const word = sentence.words.find((w, i) => {
        // 重新计算全局索引
        let idx = 0;
        for (let s = 0; s < sentenceIdx; s++) {
            idx += state.sentences[s].words.length;
        }
        idx += i;
        return idx === globalIdx;
    });

    if (word) {
        word.deleted = !word.deleted;
        wordSpan.classList.toggle('deleted');

        // seek 到该词时间点
        elements.videoPlayer.currentTime = word.begin_time / 1000;
    }

    updateDeletedCount();
    updateButtonStates();
}

function highlightCurrentWord() {
    const currentTime = elements.videoPlayer.currentTime * 1000; // 转换为毫秒

    // 移除所有 current 样式
    document.querySelectorAll('.word.current').forEach(el => {
        el.classList.remove('current');
    });

    // 找到当前时间对应的词
    for (const sentence of state.sentences) {
        if (currentTime >= sentence.begin_time && currentTime < sentence.end_time) {
            for (const word of sentence.words) {
                if (currentTime >= word.begin_time && currentTime < word.end_time) {
                    // 找到对应的 DOM 元素
                    const wordEls = document.querySelectorAll('.word');
                    let idx = 0;
                    for (let s = 0; s < state.sentences.indexOf(sentence); s++) {
                        idx += state.sentences[s].words.length;
                    }
                    idx += sentence.words.indexOf(word);

                    if (wordEls[idx]) {
                        wordEls[idx].classList.add('current');

                        // 自动滚动到当前词
                        wordEls[idx].scrollIntoView({
                            behavior: 'smooth',
                            block: 'center'
                        });
                    }
                    break;
                }
            }
            break;
        }
    }
}

// ========== 历史记录（撤销） ==========

function saveHistory() {
    // 深拷贝当前状态
    const snapshot = JSON.parse(JSON.stringify(state.sentences));
    state.history.push(snapshot);
    updateButtonStates();
}

function undo() {
    if (state.history.length === 0) return;

    const previous = state.history.pop();
    state.sentences = previous;

    // 重新渲染
    renderSubtitles();
    updateDeletedCount();
    updateButtonStates();
}

function resetAll() {
    if (state.history.length === 0) return;

    // 重置到初始状态（清空所有 deleted）
    state.sentences.forEach(sentence => {
        sentence.words.forEach(word => {
            word.deleted = false;
        });
    });
    state.history = [];

    renderSubtitles();
    updateDeletedCount();
    updateButtonStates();
}

// ========== 导出功能 ==========

async function exportVideo() {
    elements.btnExport.disabled = true;
    elements.btnExport.textContent = '正在导出...';

    try {
        const response = await fetch(`/api/cut/${state.videoId}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                sentences: state.sentences,
            }),
        });

        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.detail || '导出失败');
        }

        const data = await response.json();

        // 显示结果
        state.outputFilename = data.output_filename;
        showSection('result');
        elements.resultFilename.textContent = '已生成: ' + data.output_filename;

    } catch (error) {
        alert('导出失败: ' + error.message);
    } finally {
        elements.btnExport.disabled = false;
        elements.btnExport.textContent = '导出剪辑视频';
    }
}

function downloadVideo() {
    if (!state.outputFilename) return;

    // 通过 iframe 触发下载
    elements.downloadFrame.src = `/api/download/${state.outputFilename}`;
}

// ========== UI 辅助函数 ==========

function showSection(section) {
    elements.uploadSection.classList.add('hidden');
    elements.loadingSection.classList.add('hidden');
    elements.editSection.classList.add('hidden');
    elements.resultSection.classList.add('hidden');

    switch (section) {
        case 'upload':
            elements.uploadSection.classList.remove('hidden');
            break;
        case 'loading':
            elements.loadingSection.classList.remove('hidden');
            break;
        case 'edit':
            elements.editSection.classList.remove('hidden');
            elements.videoFilename.textContent = state.filename;
            elements.videoDuration.textContent = formatTime(state.duration);
            break;
        case 'result':
            elements.resultSection.classList.remove('hidden');
            break;
    }
}

function updateLoadingText(text) {
    elements.loadingText.textContent = text;
}

function updateDeletedCount() {
    let deletedCount = 0;
    let totalCount = 0;

    state.sentences.forEach(sentence => {
        sentence.words.forEach(word => {
            totalCount++;
            if (word.deleted) deletedCount++;
        });
    });

    elements.deletedCount.textContent = `已删除: ${deletedCount} 个词 (共 ${totalCount} 个)`;
}

function updateButtonStates() {
    elements.btnUndo.disabled = state.history.length === 0;
    elements.btnReset.disabled = state.history.length === 0;

    // 检查是否有删除的词
    const hasDeleted = state.sentences.some(s =>
        s.words.some(w => w.deleted)
    );
    elements.btnExport.disabled = !hasDeleted;
}

function formatTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

function startNew() {
    // 重置状态
    state.videoId = null;
    state.filename = null;
    state.duration = 0;
    state.sentences = [];
    state.history = [];
    state.outputFilename = null;

    // 清空输入
    elements.fileInput.value = '';

    // 显示上传界面
    showSection('upload');
}

// ========== 初始化 ==========

function init() {
    initUpload();

    // 撤销
    elements.btnUndo.addEventListener('click', undo);

    // 重置
    elements.btnReset.addEventListener('click', resetAll);

    // 导出
    elements.btnExport.addEventListener('click', exportVideo);

    // 下载
    elements.btnDownload.addEventListener('click', downloadVideo);

    // 新建
    elements.btnNew.addEventListener('click', startNew);
}

// 启动
init();
