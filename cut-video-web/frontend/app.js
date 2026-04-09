/**
 * ASR 视频剪辑工作室 - 前端逻辑
 */

(function() {
    'use strict';

    // ==================== STATE ====================
    const state = {
        videoId: null,
        filename: null,
        duration: 0,
        sentences: [],
        history: [],
        outputFilename: null,
        currentWordIndex: -1,
        burnSubtitles: false,
        subtitleEntries: [], // [{start_ms, end_ms, text}, ...]
        keptSegments: null,     // [{start_ms, end_ms}, ...] 当前保留段
        hasTranscription: false,    // 是否已生成字幕
    };

    // ==================== DOM ====================
    const $ = id => document.getElementById(id);

    const dom = {
        // Views
        viewUpload: $('view-upload'),
        viewLoading: $('view-loading'),
        viewEditor: $('view-editor'),

        // Upload
        uploadCard: $('upload-card'),
        fileInput: $('file-input'),

        // Loading
        loadingTitle: $('loading-title'),
        loadingDesc: $('loading-desc'),
        loadingBar: $('loading-bar'),

        // Header
        btnPlay: $('btn-play'),
        btnBack: $('btn-back'),
        btnForward: $('btn-forward'),
        btnUndo: $('btn-undo'),
        btnReset: $('btn-reset'),
        btnExport: $('btn-export'),

        btnGenerate: $('btn-generate'),
        btnSelectVideo: $('btn-select-video'),
        fileInputEditor: $('file-input-editor'),
        toggleSubtitles: $('toggle-subtitles'),
        timeCurrent: $('time-current'),
        timeTotal: $('time-total'),

        // Video
        videoPlayer: $('video-player'),
        progressBar: $('progress-bar'),
        progressFill: $('progress-fill'),
        progressThumb: $('progress-thumb'),
        subtitleOverlay: $('subtitle-overlay'),
        previewBadge: $('preview-badge'),
        fileLabel: $('file-label'),

        // Timeline
        timelineRuler: $('timeline-ruler'),
        timelineTrack: $('timeline-track'),

        // Word List
        wordList: $('word-list'),

        // Stats
        statDeleted: $('stat-deleted'),
        statEdited: $('stat-edited'),
        statTotal: $('stat-total'),

        // Modal - Export
        modalExport: $('modal-export'),
        modalExportTitle: $('modal-export-title'),
        modalExportDesc: $('modal-export-desc'),
        modalExportIcon: $('modal-export-icon'),
        modalExportActions: $('modal-export-actions'),
        exportProgress: $('export-progress'),
        exportProgressFill: $('export-progress-fill'),
        exportOutputInfo: $('export-output-info'),
        outputPath: $('output-path'),
        btnExportOk: $('btn-export-ok'),

        // Modal - Legacy
        modalResult: $('modal-result'),
        modalKept: $('modal-kept'),
        btnDownload: $('btn-download'),
        btnNew: $('btn-new'),
        downloadFrame: $('download-frame'),

        // Toast
        toastContainer: $('toast-container'),
    };

    // ==================== INIT ====================
    function init() {
        initUpload();
        initVideoPlayer();
        initTransport();
        initActions();
        initExportModal();
        initKeyboard();
        initSubtitleToggle();
        initSelectVideo();
    }

    // ==================== UPLOAD ====================
    function initUpload() {
        dom.uploadCard.addEventListener('click', () => dom.fileInput.click());
        dom.fileInput.addEventListener('change', handleFileSelect);

        dom.uploadCard.addEventListener('dragover', e => {
            e.preventDefault();
            dom.uploadCard.classList.add('dragover');
        });

        dom.uploadCard.addEventListener('dragleave', () => {
            dom.uploadCard.classList.remove('dragover');
        });

        dom.uploadCard.addEventListener('drop', e => {
            e.preventDefault();
            dom.uploadCard.classList.remove('dragover');
            if (e.dataTransfer.files.length > 0) {
                handleFile(e.dataTransfer.files[0]);
            }
        });
    }

    function handleFileSelect(e) {
        if (e.target.files.length > 0) {
            handleFile(e.target.files[0]);
        }
    }

    async function handleFile(file) {
        if (!file.type.startsWith('video/')) {
            showToast('请选择视频文件', 'error');
            return;
        }

        showView('loading');
        updateLoading('正在上传...', '视频上传中，请稍候...');

        const formData = new FormData();
        formData.append('file', file);

        try {
            const response = await fetch('/api/upload', {
                method: 'POST',
                body: formData,
            });

            if (!response.ok) throw new Error('上传失败');

            const data = await response.json();
            state.videoId = data.video_id;
            state.filename = data.filename;
            dom.fileLabel.textContent = data.filename;

            // 上传完成，直接进入编辑器视图（无字幕）
            dom.videoPlayer.src = `/api/video/${state.videoId}`;
            dom.videoPlayer.addEventListener('loadedmetadata', function onMeta() {
                dom.videoPlayer.removeEventListener('loadedmetadata', onMeta);
                state.duration = dom.videoPlayer.duration;
                dom.timeTotal.textContent = formatTimecode(state.duration);
            });
            state.hasTranscription = false;
            dom.wordList.innerHTML = '<div class="word-list-placeholder">点击上方「生成字幕」按钮开始 ASR 转写</div>';
            showView('editor');
            updateButtonStates();

        } catch (error) {
            showToast('上传失败: ' + error.message, 'error');
            showView('upload');
        }
    }

    async function loadTranscription() {
        try {
            const response = await fetch(`/api/timestamps/${state.videoId}`);
            if (!response.ok) throw new Error('加载失败');

            const data = await response.json();
            state.sentences = data.sentences;
            state.duration = data.duration;
            state.hasTranscription = true;

            dom.timeTotal.textContent = formatTimecode(state.duration);

            renderTimeline();
            renderWordList();
            updateStats();
            rebuildPlayback();

            showToast('字幕生成完成');

        } catch (error) {
            showToast('加载失败: ' + error.message, 'error');
        }
    }

    // ==================== VIEW SWITCHING ====================
    function showView(name) {
        dom.viewUpload.classList.remove('active');
        dom.viewLoading.classList.remove('active');
        dom.viewEditor.classList.remove('active');

        switch (name) {
            case 'upload':
                dom.viewUpload.classList.add('active');
                break;
            case 'loading':
                dom.viewLoading.classList.add('active');
                break;
            case 'editor':
                dom.viewEditor.classList.add('active');
                break;
        }
    }

    function updateLoading(title, desc) {
        dom.loadingTitle.textContent = title;
        dom.loadingDesc.textContent = desc;
        dom.loadingBar.style.width = '20%';
    }

    // ==================== VIDEO PLAYER ====================
    function initVideoPlayer() {
        dom.videoPlayer.addEventListener('timeupdate', onTimeUpdate);
        dom.videoPlayer.addEventListener('ended', () => setPlayState(false));

        dom.progressBar.addEventListener('click', e => {
            const rect = dom.progressBar.getBoundingClientRect();
            const percent = (e.clientX - rect.left) / rect.width;
            const virtualDuration = getVirtualDuration();
            const virtualMs = percent * virtualDuration;
            const originalMs = virtualToOriginal(virtualMs, state.keptSegments);
            dom.videoPlayer.currentTime = originalMs / 1000;
        });
    }

    function onTimeUpdate() {
        const currentMs = dom.videoPlayer.currentTime * 1000;
        const segments = state.keptSegments;

        // 跳段播放引擎：检查当前时间是否在保留段内
        if (segments && segments.length > 0) {
            const lastSeg = segments[segments.length - 1];
            // 超过最后一个保留段的终点，暂停
            if (currentMs >= lastSeg.end_ms) {
                dom.videoPlayer.pause();
                setPlayState(false);
                return;
            }

            // 检查是否落入删除区间
            let inKept = false;
            for (let i = 0; i < segments.length; i++) {
                const seg = segments[i];
                if (currentMs >= seg.start_ms && currentMs < seg.end_ms) {
                    inKept = true;
                    break;
                }
            }

            if (!inKept) {
                // 落在删除区间，seek 到下一个保留段起点
                for (let i = 0; i < segments.length; i++) {
                    if (segments[i].start_ms > currentMs) {
                        dom.videoPlayer.currentTime = segments[i].start_ms / 1000;
                        return;
                    }
                }
                // 没有更多保留段，暂停
                dom.videoPlayer.pause();
                setPlayState(false);
                return;
            }
        }

        // 更新进度条（虚拟时间轴）
        const virtualDuration = getVirtualDuration();
        const virtualCurrent = originalToVirtual(currentMs, segments);
        const percent = virtualDuration > 0 ? (virtualCurrent / virtualDuration) * 100 : 0;

        dom.progressFill.style.width = percent + '%';
        dom.progressThumb.style.left = percent + '%';
        dom.timeCurrent.textContent = formatTimecode(virtualCurrent / 1000);

        highlightCurrentWord();
    }

    function setPlayState(playing) {
        const iconPlay = dom.btnPlay.querySelector('.icon-play');
        const iconPause = dom.btnPlay.querySelector('.icon-pause');

        if (playing) {
            iconPlay.style.display = 'none';
            iconPause.style.display = 'block';
        } else {
            iconPlay.style.display = 'block';
            iconPause.style.display = 'none';
        }
    }

    // ==================== TRANSPORT ====================
    function initTransport() {
        dom.btnPlay.addEventListener('click', togglePlay);
        dom.btnBack.addEventListener('click', () => seek(-5));
        dom.btnForward.addEventListener('click', () => seek(5));
    }

    function togglePlay() {
        if (dom.videoPlayer.paused) {
            dom.videoPlayer.play();
            setPlayState(true);
        } else {
            dom.videoPlayer.pause();
            setPlayState(false);
        }
    }

    function seek(seconds) {
        dom.videoPlayer.currentTime = Math.max(0, Math.min(
            dom.videoPlayer.currentTime + seconds,
            state.duration
        ));
    }

    // ==================== TIMELINE ====================
    function renderTimeline() {
        // Ruler
        dom.timelineRuler.innerHTML = '';
        const ticks = calculateTicks(state.duration);
        ticks.forEach(tick => {
            const el = document.createElement('div');
            el.className = 'timeline-tick';
            el.style.left = tick.percent + '%';
            el.innerHTML = `<span class="timeline-tick-label">${tick.label}</span>`;
            dom.timelineRuler.appendChild(el);
        });

        // Word blocks
        dom.timelineTrack.innerHTML = '';
        const allWords = getAllWords();

        allWords.forEach((word, index) => {
            const block = document.createElement('div');
            const isSilence = word.type === 'silence';
            block.className = 'word-block' + (isSilence ? ' silence' : '');
            block.dataset.index = index;

            const startPercent = (word.begin_time / (state.duration * 1000)) * 100;
            const widthPercent = ((word.end_time - word.begin_time) / (state.duration * 1000)) * 100;

            block.style.left = startPercent + '%';
            block.style.width = Math.max(widthPercent, 2) + '%';
            block.textContent = isSilence ? '🔇' : (word.text.length > 6 ? word.text.slice(0, 6) : word.text);

            block.addEventListener('click', () => toggleWordByGlobalIndex(index));

            dom.timelineTrack.appendChild(block);
        });
    }

    function calculateTicks(duration) {
        const ticks = [];
        const seconds = Math.ceil(duration);

        let interval = 1;
        if (seconds > 300) interval = 30;
        else if (seconds > 120) interval = 15;
        else if (seconds > 60) interval = 10;
        else if (seconds > 30) interval = 5;

        for (let i = 0; i <= seconds; i += interval) {
            ticks.push({
                percent: (i / seconds) * 100,
                label: formatTimeShort(i)
            });
        }

        return ticks;
    }

    function updateTimelineHighlights() {
        const allWords = getAllWords();
        const blocks = dom.timelineTrack.querySelectorAll('.word-block');

        blocks.forEach((block, index) => {
            block.classList.toggle('deleted', allWords[index].deleted);
            block.classList.toggle('silence', allWords[index].type === 'silence');
        });
    }

    // ==================== WORD LIST ====================
    function renderWordList() {
        dom.wordList.innerHTML = '';

        state.sentences.forEach((sentence, sIdx) => {
            const block = document.createElement('div');
            block.className = 'sentence-block';

            // 点击句子块任意非字幕区域删除整个句子
            block.addEventListener('click', e => {
                // 如果点击的是单词本身，不处理
                if (e.target.classList.contains('word')) return;
                toggleSentence(sIdx);
            });

            const time = document.createElement('div');
            time.className = 'sentence-time';
            time.textContent = `${formatTimecode(sentence.begin_time / 1000)} → ${formatTimecode(sentence.end_time / 1000)}`;
            block.appendChild(time);

            const words = document.createElement('div');
            words.className = 'sentence-words';

            sentence.words.forEach((word, wIdx) => {
                const el = document.createElement('span');
                const isSilence = word.type === 'silence';
                el.className = 'word' + (isSilence ? ' silence' : '');
                el.textContent = isSilence ? word.text : (word.edited_text || word.text);
                el.dataset.sentenceIdx = sIdx;
                el.dataset.wordIdx = wIdx;

                if (word.deleted) el.classList.add('deleted');
                if (word.edited_text && !isSilence) el.classList.add('edited');

                if (!isSilence) {
                    // 单击延迟 + 双击取消机制，避免编辑/删除冲突
                    let clickTimer = null;
                    el.addEventListener('click', e => {
                        e.stopPropagation();
                        if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; return; }
                        clickTimer = setTimeout(() => { clickTimer = null; toggleWord(sIdx, wIdx, el); }, 250);
                    });
                    el.addEventListener('dblclick', e => {
                        e.stopPropagation();
                        if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
                        startEditWord(sIdx, wIdx, el);
                    });
                } else {
                    el.addEventListener('click', e => {
                        e.stopPropagation();
                        toggleWord(sIdx, wIdx, el);
                    });
                }

                words.appendChild(el);
            });

            block.appendChild(words);
            dom.wordList.appendChild(block);
        });
    }

    function highlightCurrentWord() {
        const currentMs = dom.videoPlayer.currentTime * 1000;

        // Subtitle overlay - 显示完整字幕行（与烧录逻辑一致）
        const entry = state.subtitleEntries.find(
            e => currentMs >= e.start_ms && currentMs < e.end_ms
        );
        if (entry) {
            dom.subtitleOverlay.textContent = entry.text;
            dom.subtitleOverlay.classList.add('visible');
        } else {
            dom.subtitleOverlay.classList.remove('visible');
        }
    }

    // ==================== TIME MAPPING ====================
    /**
     * 原始时间 → 虚拟时间（进度条显示用）
     */
    function originalToVirtual(originalMs, segments) {
        if (!segments || !segments.length) return originalMs;
        let cumulative = 0;
        for (const seg of segments) {
            if (originalMs < seg.start_ms) return cumulative;
            if (originalMs <= seg.end_ms) return cumulative + (originalMs - seg.start_ms);
            cumulative += (seg.end_ms - seg.start_ms);
        }
        return cumulative;
    }

    /**
     * 虚拟时间 → 原始时间（进度条点击/拖拽用）
     */
    function virtualToOriginal(virtualMs, segments) {
        if (!segments || !segments.length) return virtualMs;
        let cumulative = 0;
        for (const seg of segments) {
            const segLen = seg.end_ms - seg.start_ms;
            if (virtualMs <= cumulative + segLen) {
                return seg.start_ms + (virtualMs - cumulative);
            }
            cumulative += segLen;
        }
        // 超出末尾
        const last = segments[segments.length - 1];
        return last.end_ms;
    }

    /**
     * 获取虚拟总时长（保留段时长之和）
     */
    function getVirtualDuration() {
        if (!state.keptSegments || !state.keptSegments.length) {
            return state.duration * 1000;
        }
        return state.keptSegments.reduce((sum, seg) => sum + (seg.end_ms - seg.start_ms), 0);
    }

    /**
     * 按标点分割词列表 - 与 subtitle.py _split_words_by_punctuation_positions 完全对齐
     */
    function splitWordsByPunctuation(sentenceText, words) {
        const punctuations = '，。！？、；：\u201c\u201d\u2018\u2019（）';
        
        // 找出所有标点位置
        const punctPositions = new Set();
        for (let i = 0; i < sentenceText.length; i++) {
            if (punctuations.includes(sentenceText[i])) {
                punctPositions.add(i);
            }
        }
        
        if (punctPositions.size === 0) return [words];
        
        // 逐词匹配在句子中的位置
        const wordPositions = []; // [{start, end}]
        let searchStart = 0;
        for (const word of words) {
            const idx = sentenceText.indexOf(word.text, searchStart);
            if (idx >= 0) {
                wordPositions.push({ start: idx, end: idx + word.text.length - 1 });
                searchStart = idx + word.text.length;
            } else {
                wordPositions.push({ start: -1, end: -1 });
            }
        }
        
        // 确定分割点
        const splitIndices = new Set();
        for (const p of punctPositions) {
            for (let i = 0; i < wordPositions.length; i++) {
                const { start, end } = wordPositions[i];
                if (start > p) {
                    if (i > 0) splitIndices.add(i - 1);
                    break;
                } else if (start <= p && p <= end) {
                    splitIndices.add(i);
                    break;
                }
            }
        }
        
        // 处理句尾标点
        if (wordPositions.length > 0) {
            const lastEnd = wordPositions[wordPositions.length - 1].end;
            if (lastEnd >= 0) {
                for (const p of punctPositions) {
                    if (p > lastEnd) {
                        splitIndices.add(words.length - 1);
                        break;
                    }
                }
            }
        }
        
        // 分割
        const segments = [];
        let current = [];
        for (let i = 0; i < words.length; i++) {
            current.push(words[i]);
            if (splitIndices.has(i)) {
                segments.push(current);
                current = [];
            }
        }
        if (current.length) segments.push(current);
        
        return segments;
    }

    /**
     * 构建字幕条目缓存 - 与 subtitle.py _build_sentence_subtitles 逻辑一致
     * 使用原始时间戳（预览播放原始视频）
     */
    function buildSubtitleEntries() {
        const entries = [];

        for (const sentence of state.sentences) {
            const words = sentence.words || [];
            if (!words.length) continue;

            const segments = splitWordsByPunctuation(sentence.text, words);

            for (const segWords of segments) {
                const kept = segWords.filter(w => !w.deleted && w.type !== 'silence');
                if (!kept.length) continue;

                const text = kept.map(w => w.edited_text || w.text).join('');
                entries.push({
                    start_ms: kept[0].begin_time,
                    end_ms: kept[kept.length - 1].end_time,
                    text,
                });
            }
        }

        state.subtitleEntries = entries;
    }

    // ==================== WORD EDIT ====================
    function startEditWord(sentenceIdx, wordIdx, element) {
        const word = state.sentences[sentenceIdx].words[wordIdx];
        if (word.type === 'silence') return;

        const currentText = word.edited_text || word.text;
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'word-edit-input';
        input.value = currentText;

        element.replaceWith(input);
        input.focus();
        input.select();

        let confirmed = false;
        const confirm = () => {
            if (confirmed) return;
            confirmed = true;
            const newText = input.value.trim();
            if (newText && newText !== word.text) {
                saveHistory();
                word.edited_text = newText;
            } else {
                if (word.edited_text) saveHistory();
                delete word.edited_text;
            }
            renderWordList();
            updateStats();
            rebuildPlayback();
        };

        input.addEventListener('blur', confirm);
        input.addEventListener('keydown', e => {
            if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
            if (e.key === 'Escape') { input.value = word.text; input.blur(); }
            e.stopPropagation();
        });
    }

    // ==================== WORD TOGGLE ====================
    function getAllWords() {
        const words = [];
        state.sentences.forEach(s => s.words.forEach(w => words.push(w)));
        return words;
    }

    function getGlobalIndex(sentenceIdx, wordIdx) {
        let idx = 0;
        for (let s = 0; s < sentenceIdx; s++) {
            idx += state.sentences[s].words.length;
        }
        return idx + wordIdx;
    }

    function toggleWord(sentenceIdx, wordIdx, element) {
        saveHistory();

        const word = state.sentences[sentenceIdx].words[wordIdx];
        word.deleted = !word.deleted;

        element.classList.toggle('deleted', word.deleted);

        const globalIdx = getGlobalIndex(sentenceIdx, wordIdx);
        const block = dom.timelineTrack.querySelector(`.word-block[data-index="${globalIdx}"]`);
        if (block) block.classList.toggle('deleted', word.deleted);

        dom.videoPlayer.currentTime = word.begin_time / 1000;

        updateStats();
        rebuildPlayback();
    }

    function toggleSentence(sentenceIdx) {
        saveHistory();

        const sentence = state.sentences[sentenceIdx];
        const allDeleted = sentence.words.every(w => w.deleted);

        sentence.words.forEach((word, wIdx) => {
            word.deleted = !allDeleted;

            const wordEl = dom.wordList.querySelector(
                `.word[data-sentence-idx="${sentenceIdx}"][data-word-idx="${wIdx}"]`
            );
            if (wordEl) wordEl.classList.toggle('deleted', word.deleted);

            const globalIdx = getGlobalIndex(sentenceIdx, wIdx);
            const block = dom.timelineTrack.querySelector(`.word-block[data-index="${globalIdx}"]`);
            if (block) block.classList.toggle('deleted', word.deleted);
        });

        dom.videoPlayer.currentTime = sentence.begin_time / 1000;

        updateStats();
        rebuildPlayback();
    }

    function toggleWordByGlobalIndex(globalIdx) {
        let idx = 0;
        for (let s = 0; s < state.sentences.length; s++) {
            for (let w = 0; w < state.sentences[s].words.length; w++) {
                if (idx === globalIdx) {
                    const wordEl = dom.wordList.querySelector(
                        `.word[data-sentence-idx="${s}"][data-word-idx="${w}"]`
                    );
                    if (wordEl) toggleWord(s, w, wordEl);
                    return;
                }
                idx++;
            }
        }
    }

    // ==================== HISTORY ====================
    function saveHistory() {
        state.history.push(JSON.parse(JSON.stringify(state.sentences)));
        updateButtonStates();
    }

    function undo() {
        if (!state.history.length) return;
        state.sentences = state.history.pop();
        renderWordList();
        updateTimelineHighlights();
        updateStats();
        rebuildPlayback();
        showToast('已撤销');
    }

    function resetAll() {
        if (!state.history.length) return;

        state.sentences.forEach(s => s.words.forEach(w => {
            w.deleted = false;
            delete w.edited_text;
        }));
        state.history = [];

        renderWordList();
        updateTimelineHighlights();
        updateStats();
        rebuildPlayback();
        showToast('已重置');
    }

    // ==================== ACTIONS ====================
    function initActions() {
        dom.btnUndo.addEventListener('click', undo);
        dom.btnReset.addEventListener('click', resetAll);
        dom.btnExport.addEventListener('click', exportVideo);
        dom.btnGenerate.addEventListener('click', generateSubtitles);
    }

    function updateStats() {
        let deleted = 0, edited = 0, total = 0;
        state.sentences.forEach(s => s.words.forEach(w => {
            total++;
            if (w.deleted) deleted++;
            if (w.edited_text) edited++;
        }));
        dom.statDeleted.textContent = deleted;
        dom.statEdited.textContent = edited;
        dom.statTotal.textContent = total;
    }

    function updateButtonStates() {
        const hasHistory = state.history.length > 0;

        dom.btnUndo.disabled = !hasHistory;
        dom.btnReset.disabled = !hasHistory;
        dom.btnExport.disabled = !state.hasTranscription;
        dom.btnGenerate.disabled = !state.videoId || state.hasTranscription;
    }

    // ==================== GENERATE SUBTITLES ====================
    async function generateSubtitles() {
        if (!state.videoId) return;
        dom.btnGenerate.disabled = true;

        try {
            // 触发 ASR
            const triggerResp = await fetch(`/api/transcribe/${state.videoId}`, { method: 'POST' });
            if (!triggerResp.ok) throw new Error('ASR 启动失败');

            const triggerData = await triggerResp.json();

            // 如果已完成，直接加载
            if (triggerData.status === 'done') {
                await loadTranscription();
                return;
            }

            // 显示加载视图
            showView('loading');
            updateLoading('ASR 转写中...', '正在进行 ASR 转写（v1 + 热词）...');
            dom.loadingBar.style.width = '20%';

            // 轮询状态，完成后回到编辑器
            let polls = 0;
            const maxPolls = 300;

            const tick = async () => {
                if (polls++ > maxPolls) {
                    showToast('转写超时，请重试', 'error');
                    showView('editor');
                    updateButtonStates();
                    return;
                }

                try {
                    const response = await fetch(`/api/status/${state.videoId}`);
                    const data = await response.json();

                    if (data.status === 'done') {
                        showView('editor');
                        await loadTranscription();
                    } else if (data.status === 'error') {
                        showToast('转写失败: ' + data.error, 'error');
                        showView('editor');
                        updateButtonStates();
                    } else {
                        const progress = Math.min(85, 20 + (polls / maxPolls) * 65);
                        dom.loadingBar.style.width = progress + '%';
                        setTimeout(tick, 1000);
                    }
                } catch (error) {
                    setTimeout(tick, 1000);
                }
            };

            tick();

        } catch (error) {
            showToast('生成字幕失败: ' + error.message, 'error');
            dom.btnGenerate.disabled = false;
        }
    }

    // ==================== SELECT VIDEO ====================
    function initSelectVideo() {
        dom.btnSelectVideo.addEventListener('click', () => {
            dom.fileInputEditor.click();
        });
        dom.fileInputEditor.addEventListener('change', e => {
            if (e.target.files.length > 0) {
                // 重置当前状态并处理新文件
                resetState();
                handleFile(e.target.files[0]);
                e.target.value = '';
            }
        });
    }

    function resetState() {
        state.videoId = null;
        state.filename = null;
        state.duration = 0;
        state.sentences = [];
        state.history = [];
        state.outputFilename = null;
        state.currentWordIndex = -1;
        state.keptSegments = null;
        state.hasTranscription = false;

        dom.videoPlayer.src = '';
        dom.wordList.innerHTML = '';
        dom.timelineTrack.innerHTML = '';
        dom.timelineRuler.innerHTML = '';
        dom.progressFill.style.width = '0%';
        dom.progressThumb.style.left = '0%';
        dom.timeCurrent.textContent = '00:00:00';
        dom.timeTotal.textContent = '00:00:00';
        dom.subtitleOverlay.classList.remove('visible');
        dom.previewBadge.classList.remove('visible');
    }

    // ==================== KEPT SEGMENTS & REBUILD ====================
    /**
     * 前端计算保留段（与后端 cut.py 反向剔除算法一致）
     */
    function buildKeptSegments() {
        const PADDING_MS = 30;
        const durationMs = state.duration * 1000;

        // 预处理：自动删除被删除词包围的静默标记
        for (const sentence of state.sentences) {
            const words = sentence.words || [];
            for (let i = 0; i < words.length; i++) {
                const word = words[i];
                if (word.type === 'silence' && !word.deleted) {
                    let prevDeleted = true;
                    let nextDeleted = true;
                    for (let j = i - 1; j >= 0; j--) {
                        if (words[j].type !== 'silence') {
                            prevDeleted = words[j].deleted || false;
                            break;
                        }
                    }
                    for (let j = i + 1; j < words.length; j++) {
                        if (words[j].type !== 'silence') {
                            nextDeleted = words[j].deleted || false;
                            break;
                        }
                    }
                    if (prevDeleted && nextDeleted) {
                        word.deleted = true;
                    }
                }
            }
        }

        // 收集删除段
        const deletedRanges = [];
        let hasAnyKept = false;
        for (const sentence of state.sentences) {
            for (const word of (sentence.words || [])) {
                if (word.deleted) {
                    deletedRanges.push([word.begin_time, word.end_time]);
                } else if (word.type !== 'silence') {
                    hasAnyKept = true;
                }
            }
        }

        if (!hasAnyKept || !deletedRanges.length) {
            state.keptSegments = null; // 无删除，播放原始视频
            return;
        }

        // 合并重叠删除段
        deletedRanges.sort((a, b) => a[0] - b[0]);
        const merged = [deletedRanges[0].slice()];
        for (let i = 1; i < deletedRanges.length; i++) {
            const last = merged[merged.length - 1];
            const curr = deletedRanges[i];
            if (curr[0] <= last[1] + PADDING_MS) {
                last[1] = Math.max(last[1], curr[1]);
            } else {
                merged.push(curr.slice());
            }
        }

        // 构建补集
        const keptSegments = [];
        let cursor = 0;
        for (const [delStart, delEnd] of merged) {
            const segStart = cursor;
            const segEnd = Math.max(cursor, delStart - PADDING_MS);
            if (segEnd > segStart) {
                keptSegments.push({ start_ms: segStart, end_ms: segEnd });
            }
            cursor = delEnd + PADDING_MS;
        }
        if (cursor < durationMs) {
            keptSegments.push({ start_ms: cursor, end_ms: durationMs });
        }

        // 过滤无内容段
        const filtered = keptSegments.filter(seg => {
            return state.sentences.some(sent =>
                (sent.words || []).some(w =>
                    !w.deleted && w.type !== 'silence' &&
                    w.begin_time < seg.end_ms && w.end_time > seg.start_ms
                )
            );
        });

        state.keptSegments = filtered.length > 0 ? filtered : null;
    }

    /**
     * 重建播放状态（每次编辑操作后调用）
     */
    function rebuildPlayback() {
        buildKeptSegments();
        buildSubtitleEntries();
        updateButtonStates();

        // 更新总时长显示
        const virtualDuration = getVirtualDuration();
        dom.timeTotal.textContent = formatTimecode(virtualDuration / 1000);

        // 显示/隐藏预览标签
        if (state.keptSegments) {
            dom.previewBadge.textContent = '已编辑';
            dom.previewBadge.classList.add('visible');
        } else {
            dom.previewBadge.classList.remove('visible');
        }
    }

    // ==================== EXPORT ====================
    async function exportVideo() {
        dom.btnExport.disabled = true;

        try {
            const originalName = (state.filename || 'video').replace(/\.[^.]+$/, '');
            const suggestedName = `${originalName}_cut.mp4`;

            // 尝试使用原生保存对话框（Chrome/Edge），不支持则降级为传统下载
            const hasFilePicker = typeof window.showSaveFilePicker === 'function';
            let fileHandle = null;

            if (hasFilePicker) {
                try {
                    fileHandle = await window.showSaveFilePicker({
                        suggestedName,
                        types: [{
                            description: 'MP4 视频',
                            accept: { 'video/mp4': ['.mp4'] },
                        }],
                    });
                } catch (e) {
                    // 用户取消
                    dom.btnExport.disabled = !state.hasTranscription;
                    return;
                }
            }

            // 显示导出进度弹窗
            showExportModal();

            // 后端导出（直接从原始视频剪辑导出）
            const response = await fetch(`/api/export/${state.videoId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    sentences: state.sentences,
                    burn_subtitles: state.burnSubtitles,
                }),
            });

            if (!response.ok) {
                const err = await response.json();
                throw new Error(err.detail || '导出失败');
            }

            const data = await response.json();

            // 下载文件
            const downloadResp = await fetch(`/api/download/${data.output_filename}`);
            if (!downloadResp.ok) throw new Error('下载导出文件失败');
            const blob = await downloadResp.blob();

            if (fileHandle) {
                // File System Access API — 写入用户选择的位置
                const writable = await fileHandle.createWritable();
                await writable.write(blob);
                await writable.close();
                showExportSuccess(fileHandle.name);
            } else {
                // Fallback — 传统浏览器下载
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = suggestedName;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
                showExportSuccess(suggestedName);
            }

        } catch (error) {
            showExportError(error.message);
        } finally {
            dom.btnExport.disabled = !state.hasTranscription;
        }
    }

    // ==================== EXPORT MODAL ====================
    function initExportModal() {
        dom.btnExportOk.addEventListener('click', hideExportModal);
    }

    function showExportModal() {
        dom.modalExportTitle.textContent = '正在导出...';
        dom.modalExportDesc.textContent = '正在处理视频，请稍候...';
        dom.exportProgress.style.display = '';
        dom.exportProgressFill.style.width = '0%';
        dom.exportProgressFill.classList.add('indeterminate');
        dom.exportOutputInfo.style.display = 'none';
        dom.modalExportActions.style.display = 'none';
        dom.modalExportIcon.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="7 10 12 15 17 10"/>
                <line x1="12" y1="15" x2="12" y2="3"/>
            </svg>`;
        dom.modalExport.classList.add('visible');
    }

    function showExportSuccess(fileName) {
        dom.modalExportTitle.textContent = '导出完成';
        dom.modalExportDesc.textContent = `已保存为 ${fileName}`;
        dom.exportProgress.style.display = 'none';
        dom.exportProgressFill.classList.remove('indeterminate');
        dom.modalExportIcon.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"/>
                <path d="M8 12l3 3 5-6"/>
            </svg>`;
        dom.exportOutputInfo.style.display = 'none';
        dom.modalExportActions.style.display = '';
    }

    function showExportError(message) {
        dom.modalExportTitle.textContent = '导出失败';
        dom.modalExportDesc.textContent = message;
        dom.exportProgress.style.display = 'none';
        dom.exportProgressFill.classList.remove('indeterminate');
        dom.modalExportIcon.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"/>
                <line x1="15" y1="9" x2="9" y2="15"/>
                <line x1="9" y1="9" x2="15" y2="15"/>
            </svg>`;
        dom.exportOutputInfo.style.display = 'none';
        dom.modalExportActions.style.display = '';
    }

    function hideExportModal() {
        dom.modalExport.classList.remove('visible');
    }

    function startNew() {
        hideExportModal();
        resetState();

        dom.fileInput.value = '';
        dom.fileLabel.textContent = '—';

        showView('upload');
    }

    // ==================== SUBTITLE TOGGLE ====================
    function initSubtitleToggle() {
        if (dom.toggleSubtitles) {
            dom.toggleSubtitles.addEventListener('change', e => {
                state.burnSubtitles = e.target.checked;
            });
        }
    }

    // ==================== KEYBOARD ====================
    function initKeyboard() {
        document.addEventListener('keydown', e => {
            if (e.target.tagName === 'INPUT') return;

            switch (e.code) {
                case 'Space':
                    e.preventDefault();
                    if (dom.viewEditor.classList.contains('active')) togglePlay();
                    break;
                case 'ArrowLeft':
                    e.preventDefault();
                    seek(-1);
                    break;
                case 'ArrowRight':
                    e.preventDefault();
                    seek(1);
                    break;
                case 'KeyZ':
                    if (e.metaKey || e.ctrlKey) {
                        e.preventDefault();
                        undo();
                    }
                    break;
            }
        });
    }

    // ==================== TOAST ====================
    function showToast(message, type = 'info') {
        const toast = document.createElement('div');
        toast.className = 'toast' + (type === 'error' ? ' error' : '');
        toast.textContent = message;
        dom.toastContainer.appendChild(toast);

        setTimeout(() => {
            toast.style.opacity = '0';
            setTimeout(() => toast.remove(), 200);
        }, 3000);
    }

    // ==================== UTILITIES ====================
    function formatTimecode(seconds) {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }

    function formatTimeShort(seconds) {
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        return `${m}:${s.toString().padStart(2, '0')}`;
    }

    // ==================== START ====================
    document.addEventListener('DOMContentLoaded', init);

})();
