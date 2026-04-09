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
        previewFilename: null,  // 当前预览文件名
        previewMode: false,     // 是否处于预览模式
        previewDuration: 0,     // 预览视频时长
        previewSubtitleEntries: [], // 预览模式下的调整时间戳字幕
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
        btnPreview: $('btn-preview'),
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
            buildSubtitleEntries();
            updateButtonStates();

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
            const totalDuration = state.previewMode ? state.previewDuration : state.duration;
            dom.videoPlayer.currentTime = percent * totalDuration;
        });
    }

    function onTimeUpdate() {
        const current = dom.videoPlayer.currentTime;
        const totalDuration = state.previewMode ? state.previewDuration : state.duration;
        const percent = totalDuration > 0 ? (current / totalDuration) * 100 : 0;

        dom.progressFill.style.width = percent + '%';
        dom.progressThumb.style.left = percent + '%';
        dom.timeCurrent.textContent = formatTimecode(current);

        if (state.previewMode) {
            showPreviewSubtitle();
        } else {
            highlightCurrentWord();
        }
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

                el.addEventListener('click', e => {
                    e.stopPropagation();
                    toggleWord(sIdx, wIdx, el);
                });

                if (!isSilence) {
                    el.addEventListener('dblclick', e => {
                        e.stopPropagation();
                        startEditWord(sIdx, wIdx, el);
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
        const allWords = getAllWords();

        // Clear all
        document.querySelectorAll('.word.current').forEach(el => el.classList.remove('current'));
        document.querySelectorAll('.word-block.current').forEach(el => el.classList.remove('current'));

        // Find current word
        let currentIdx = -1;
        for (let i = 0; i < allWords.length; i++) {
            if (currentMs >= allWords[i].begin_time && currentMs < allWords[i].end_time) {
                currentIdx = i;
                break;
            }
        }

        if (currentIdx >= 0 && currentIdx !== state.currentWordIndex) {
            state.currentWordIndex = currentIdx;

            // Word in list
            const wordEls = dom.wordList.querySelectorAll('.word');
            if (wordEls[currentIdx]) {
                wordEls[currentIdx].classList.add('current');
                wordEls[currentIdx].scrollIntoView({ behavior: 'smooth', block: 'center' });
            }

            // Word block
            const blockEls = dom.timelineTrack.querySelectorAll('.word-block');
            if (blockEls[currentIdx]) {
                blockEls[currentIdx].classList.add('current');
            }
        }

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

    // ==================== SUBTITLE ENTRIES ====================
    /**
     * 将原始时间映射到剪辑后时间（与 subtitle.py _map_original_to_adjusted 对齐）
     */
    function mapOriginalToAdjusted(originalMs, keptSegments) {
        let cumulative = 0;
        for (const [startMs, endMs] of keptSegments) {
            if (originalMs < startMs) return cumulative;
            if (originalMs <= endMs) return cumulative + (originalMs - startMs);
            cumulative += (endMs - startMs);
        }
        return cumulative;
    }

    /**
     * 构建预览模式的字幕条目（时间戳映射到剪辑后时间轴）
     */
    function buildPreviewSubtitleEntries(keptSegments) {
        if (!keptSegments || !keptSegments.length) {
            // 无删除（直接复制），使用原始字幕
            state.previewSubtitleEntries = [...state.subtitleEntries];
            return;
        }

        const entries = [];
        for (const sentence of state.sentences) {
            const words = sentence.words || [];
            if (!words.length) continue;

            const segments = splitWordsByPunctuation(sentence.text, words);
            for (const segWords of segments) {
                const kept = segWords.filter(w => !w.deleted && w.type !== 'silence');
                if (!kept.length) continue;

                const text = kept.map(w => w.edited_text || w.text).join('');
                const adjStart = mapOriginalToAdjusted(kept[0].begin_time, keptSegments);
                const adjEnd = mapOriginalToAdjusted(kept[kept.length - 1].end_time, keptSegments);

                if (adjEnd > adjStart) {
                    entries.push({ start_ms: adjStart, end_ms: adjEnd, text });
                }
            }
        }
        state.previewSubtitleEntries = entries;
    }

    /**
     * 预览模式下显示字幕
     */
    function showPreviewSubtitle() {
        const currentMs = dom.videoPlayer.currentTime * 1000;
        const entry = state.previewSubtitleEntries.find(
            e => currentMs >= e.start_ms && currentMs < e.end_ms
        );
        if (entry) {
            dom.subtitleOverlay.textContent = entry.text;
            dom.subtitleOverlay.classList.add('visible');
        } else {
            dom.subtitleOverlay.classList.remove('visible');
        }
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
        if (word.deleted || word.type === 'silence') return;

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
            updateButtonStates();
            exitPreviewMode();
            buildSubtitleEntries();
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

        exitPreviewMode();
        updateStats();
        updateButtonStates();
        buildSubtitleEntries();
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

        exitPreviewMode();
        updateStats();
        updateButtonStates();
        buildSubtitleEntries();
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
        exitPreviewMode();
        updateStats();
        updateButtonStates();
        buildSubtitleEntries();
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
        exitPreviewMode();
        updateStats();
        updateButtonStates();
        buildSubtitleEntries();
        showToast('已重置');
    }

    // ==================== ACTIONS ====================
    function initActions() {
        dom.btnUndo.addEventListener('click', undo);
        dom.btnReset.addEventListener('click', resetAll);
        dom.btnPreview.addEventListener('click', previewVideo);
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
        const hasDeleted = state.sentences.some(s => s.words.some(w => w.deleted));

        dom.btnUndo.disabled = !hasHistory;
        dom.btnReset.disabled = !hasHistory;
        dom.btnPreview.disabled = !hasDeleted || !state.hasTranscription;
        dom.btnExport.disabled = !state.previewMode;
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
        state.previewFilename = null;
        state.previewMode = false;
        state.previewDuration = 0;
        state.previewSubtitleEntries = [];
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

    // ==================== PREVIEW ======================================
    async function previewVideo() {
        dom.btnPreview.disabled = true;

        try {
            showToast('正在生成预览...');

            const response = await fetch(`/api/cut/${state.videoId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    sentences: state.sentences,
                }),
            });

            if (!response.ok) {
                const err = await response.json();
                throw new Error(err.detail || '剪辑失败');
            }

            const data = await response.json();
            state.previewFilename = data.output_filename;

            // 构建预览字幕（映射到剪辑后时间轴）
            buildPreviewSubtitleEntries(data.kept_segments);

            // 进入预览模式
            enterPreviewMode();

            showToast('预览已生成，正在播放');

        } catch (error) {
            showToast('剪辑失败: ' + error.message, 'error');
        } finally {
            updateButtonStates();
        }
    }

    function enterPreviewMode() {
        state.previewMode = true;

        // 切换视频源为预览文件
        const previewUrl = `/api/download/${state.previewFilename}`;
        dom.videoPlayer.src = previewUrl;
        dom.videoPlayer.addEventListener('loadedmetadata', function onLoaded() {
            dom.videoPlayer.removeEventListener('loadedmetadata', onLoaded);
            state.previewDuration = dom.videoPlayer.duration;
            dom.timeTotal.textContent = formatTimecode(state.previewDuration);
            dom.videoPlayer.play();
            setPlayState(true);
        });

        // 显示预览标签
        dom.previewBadge.classList.add('visible');

        updateButtonStates();
    }

    function exitPreviewMode() {
        if (!state.previewMode) return;

        state.previewMode = false;
        state.previewFilename = null;
        state.previewDuration = 0;
        state.previewSubtitleEntries = [];

        // 切回原始视频
        dom.videoPlayer.src = `/api/video/${state.videoId}`;
        dom.timeTotal.textContent = formatTimecode(state.duration);

        // 隐藏预览标签
        dom.previewBadge.classList.remove('visible');

        updateButtonStates();
        showToast('已修改内容，请重新执行剪辑');
    }

    // ==================== EXPORT ====================
    async function exportVideo() {
        dom.btnExport.disabled = true;

        try {
            // 先弹出原生保存对话框，让用户选择保存位置
            const originalName = (state.filename || 'video').replace(/\.[^.]+$/, '');
            let fileHandle;
            try {
                fileHandle = await window.showSaveFilePicker({
                    suggestedName: `${originalName}_cut.mp4`,
                    types: [{
                        description: 'MP4 视频',
                        accept: { 'video/mp4': ['.mp4'] },
                    }],
                });
            } catch (e) {
                // 用户取消了对话框
                dom.btnExport.disabled = !state.previewMode;
                return;
            }

            // 显示导出进度弹窗
            showExportModal();

            // 后端导出（生成最终文件）
            const response = await fetch(`/api/export/${state.videoId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    preview_filename: state.previewFilename,
                    sentences: state.sentences,
                    burn_subtitles: state.burnSubtitles,
                }),
            });

            if (!response.ok) {
                const err = await response.json();
                throw new Error(err.detail || '导出失败');
            }

            const data = await response.json();

            // 下载文件并写入用户选择的位置
            const downloadResp = await fetch(`/api/download/${data.output_filename}`);
            if (!downloadResp.ok) throw new Error('下载导出文件失败');

            const blob = await downloadResp.blob();
            const writable = await fileHandle.createWritable();
            await writable.write(blob);
            await writable.close();

            // 显示导出完成
            showExportSuccess(fileHandle.name);

        } catch (error) {
            showExportError(error.message);
        } finally {
            dom.btnExport.disabled = !state.previewMode;
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
