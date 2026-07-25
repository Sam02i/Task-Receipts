const $ = id => document.getElementById(id);

// ─────────────────────────────────────────────────────────────────────────────
// SOUND ENGINE  –  Web Audio API only, zero external files
// AudioContext is created lazily on first user interaction (browser policy).
// ─────────────────────────────────────────────────────────────────────────────
const SFX = (() => {
    let _ctx = null;
    let _muted = false;

    function ac() {
        if (!_ctx) _ctx = new (window.AudioContext || window.webkitAudioContext)();
        if (_ctx.state === 'suspended') _ctx.resume();
        return _ctx;
    }

    // ── 1. FLIP-CLOCK MINUTE TICK ────────────────────────────────────────────
    // Two simultaneous layers:
    //   • Sharp click  – high-passed noise burst  (the digit plate snapping)
    //   • Low thud     – pitched sine sweep        (the mechanical catch)
    function minuteTick() {
        if (_muted) return;
        const c   = ac();
        const now = c.currentTime;

        // Layer A: noise click
        const clickBuf  = c.createBuffer(1, Math.ceil(c.sampleRate * 0.055), c.sampleRate);
        const clickData = clickBuf.getChannelData(0);
        for (let i = 0; i < clickData.length; i++)
            clickData[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / clickData.length, 6);

        const clickSrc  = c.createBufferSource();
        clickSrc.buffer = clickBuf;

        const hpf = c.createBiquadFilter();
        hpf.type = 'highpass';
        hpf.frequency.value = 1200;

        const clickGain = c.createGain();
        clickGain.gain.setValueAtTime(0.25, now);
        clickGain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);

        clickSrc.connect(hpf);
        hpf.connect(clickGain);
        clickGain.connect(c.destination);
        clickSrc.start(now);

        // Layer B: low thud (sine 140 Hz → 55 Hz)
        const thud = c.createOscillator();
        thud.type = 'sine';
        thud.frequency.setValueAtTime(140, now);
        thud.frequency.exponentialRampToValueAtTime(55, now + 0.075);

        const thudGain = c.createGain();
        thudGain.gain.setValueAtTime(0.2, now);
        thudGain.gain.exponentialRampToValueAtTime(0.001, now + 0.085);

        thud.connect(thudGain);
        thudGain.connect(c.destination);
        thud.start(now);
        thud.stop(now + 0.09);
    }

    // ── 2. THERMAL PRINTER FEED SOUND ────────────────────────────────────────
    // Band-passed noise through two filters in parallel:
    //   • ~3 kHz  – paper-friction hiss
    //   • ~700 Hz – motor rumble
    // An LFO at 26 Hz adds the characteristic motor throb.
    // Envelope: fast attack → sustained hold → release timed to feedDurationMs.
    let _printerSrc    = null;
    let _printerGain   = null;
    let _printerLFO    = null;

    function printerStart(feedDurationMs) {
        if (_muted) return;
        printerStop(60);                        // clean up any previous sound

        const c      = ac();
        const now    = c.currentTime;
        const dur    = feedDurationMs / 1000;   // convert to seconds
        const bufLen = Math.ceil(c.sampleRate * (dur + 0.5));

        // White noise buffer
        const buf  = c.createBuffer(1, bufLen, c.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

        const src = c.createBufferSource();
        src.buffer = buf;

        // Two parallel band-pass filters
        const bpHi = c.createBiquadFilter();
        bpHi.type = 'bandpass'; bpHi.frequency.value = 3000; bpHi.Q.value = 1.1;

        const bpLo = c.createBiquadFilter();
        bpLo.type = 'bandpass'; bpLo.frequency.value = 700;  bpLo.Q.value = 2.0;

        // Merge point
        const merge = c.createGain();
        merge.gain.value = 1;

        // Master gain with envelope
        const master = c.createGain();
        master.gain.setValueAtTime(0,    now);
        master.gain.linearRampToValueAtTime(0.12, now + 0.06);        // attack
        master.gain.setValueAtTime(0.12, now + dur - 0.12);           // hold
        master.gain.linearRampToValueAtTime(0,    now + dur);         // release

        // LFO: motor throb
        const lfo     = c.createOscillator();
        lfo.frequency.value = 26;
        const lfoGain = c.createGain();
        lfoGain.gain.value = 0.015;
        lfo.connect(lfoGain);
        lfoGain.connect(master.gain);
        lfo.start(now);
        lfo.stop(now + dur + 0.1);

        // Route: src → bpHi → merge; src → bpLo → merge; merge → master → out
        src.connect(bpHi);  bpHi.connect(merge);
        src.connect(bpLo);  bpLo.connect(merge);
        merge.connect(master);
        master.connect(c.destination);

        src.start(now);
        src.stop(now + dur + 0.1);

        _printerSrc  = src;
        _printerGain = master;
        _printerLFO  = lfo;
    }

    function printerStop(fadeMs) {
        if (!_printerGain) return;
        const c    = ac();
        const now  = c.currentTime;
        const fade = (fadeMs || 120) / 1000;
        try {
            _printerGain.gain.cancelScheduledValues(now);
            _printerGain.gain.setValueAtTime(_printerGain.gain.value, now);
            _printerGain.gain.linearRampToValueAtTime(0, now + fade);
            if (_printerSrc)  try { _printerSrc.stop(now + fade + 0.05);  } catch (_) {}
            if (_printerLFO)  try { _printerLFO.stop(now + fade + 0.05);  } catch (_) {}
        } catch (_) {}
        _printerSrc = _printerGain = _printerLFO = null;
    }

    return { minuteTick, printerStart, printerStop, setMuted(v) { _muted = v; } };
})();
// ─────────────────────────────────────────────────────────────────────────────

const screenCanvas = $('screenCanvas');
if (screenCanvas) {
    screenCanvas.width = 165;
    screenCanvas.height = 108;
}

let tasks = [];
let currentTask = null;
let timerInterval = null;
let seconds = 0;
let breaksTaken = 0;
let isRunning = false;
let receipts = [];
let cameraMode = 'photo';
let selectedTheme = 'theme-white';
let selectedDither = 'dotmatrix';
let isLowInk = false;
let drawColor = '#000000';
let brushSize = 4;
let stream = null;
let isDrawing = false;
let lastX = 0, lastY = 0;
let taskStartTime = null;

const HOME_POSITIONS_KEY = 'tr_home_positions';

function getHomePositions() { try { return JSON.parse(localStorage.getItem(HOME_POSITIONS_KEY)) || {}; } catch { return {}; } }
function saveHomePosition(id, top, left, rot) { 
    const positions = getHomePositions(); 
    positions[id] = { top, left, rot }; 
    localStorage.setItem(HOME_POSITIONS_KEY, JSON.stringify(positions)); 
}

document.addEventListener('DOMContentLoaded', () => { loadTasks(); setupEventListeners(); initThemeEngine(); });

// ═══════════════════════════════════════════════════════════════════════════
// THEME ENGINE — Phase 1
// Manages app-level theme switching (Classic / Butterfly / Mitsuri).
// Applies data-app-theme to <body> and persists to localStorage.
// Visual re-styling of panels happens in Phase 3/4 via CSS vars.
// ═══════════════════════════════════════════════════════════════════════════
const APP_THEME_KEY = 'tr_app_theme';

function initThemeEngine() {
    // Restore saved theme on load
    const saved = localStorage.getItem(APP_THEME_KEY) || 'classic';
    applyAppTheme(saved, false);

    // Settings cog toggle
    const settingsBtn   = document.getElementById('settingsBtn');
    const settingsPanel = document.getElementById('settingsPanel');
    if (settingsBtn && settingsPanel) {
        settingsBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            settingsPanel.classList.toggle('open');
        });
        document.addEventListener('click', (e) => {
            if (!settingsPanel.contains(e.target) && e.target !== settingsBtn) {
                settingsPanel.classList.remove('open');
            }
        });
    }

    // Theme buttons in settings panel
    document.querySelectorAll('.app-theme-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            applyAppTheme(btn.dataset.appTheme, true);
            settingsPanel && settingsPanel.classList.remove('open');
        });
    });

    // Mute toggle (wire up here so it's always handled)
    const muteToggle = document.getElementById('muteToggle');
    if (muteToggle) {
        let muted = localStorage.getItem('tr_muted') === 'true';
        const applyMute = () => {
            muteToggle.classList.toggle('muted', muted);
            // SFX respects _muted flag checked inside minuteTick/printerStart
            SFX.setMuted(muted);
        };
        applyMute();
        muteToggle.addEventListener('click', () => {
            muted = !muted;
            localStorage.setItem('tr_muted', muted);
            applyMute();
        });
    }
}

function applyAppTheme(theme, save) {
    document.body.setAttribute('data-app-theme', theme);
    if (save) localStorage.setItem(APP_THEME_KEY, theme);

    // ── Wallpaper switching — uses wallpaper.jpg just like tray.png ──
    const wallpaperEl = document.getElementById('appWallpaper');
    if (wallpaperEl) {
        const src = theme === 'seaside' ? 'wallpaper.jpg' : null;
        if (src) {
            wallpaperEl.style.backgroundImage = `url('${src}')`;
            wallpaperEl.style.opacity = '1';
        } else {
            wallpaperEl.style.opacity = '0';
            setTimeout(() => { wallpaperEl.style.backgroundImage = 'none'; }, 400);
        }
    }
    // ────────────────────────────────────────────────────────────────

    document.querySelectorAll('.app-theme-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.appTheme === theme);
    });
}

// Expose for session-summary / archive to call
window.applyAppTheme = applyAppTheme;
window.APP_THEME_KEY = APP_THEME_KEY;
// ═══════════════════════════════════════════════════════════════════════════

function setupEventListeners() {
    $('playBtn').addEventListener('click', startTimer);
    $('pauseBtn').addEventListener('click', pauseTimer);
    $('checkBtn').addEventListener('click', finishTask);
    $('addTaskBtn').addEventListener('click', toggleTaskInput);
    $('addBtn').addEventListener('click', addTask);
    $('taskInput').addEventListener('keypress', e => { if (e.key === 'Enter') addTask(); });
    document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => switchTab(tab.dataset.tab)));
    
    $('modalClose').addEventListener('click', closeModal);
    $('modalCaptureBtn').addEventListener('click', captureImage);
    $('modalSignOffBtn').addEventListener('click', signOff);
    
    document.querySelectorAll('.mode-btn').forEach(btn => btn.addEventListener('click', () => {
        cameraMode = btn.dataset.mode;
        document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        switchModalView();
    }));
    
    document.querySelectorAll('.theme-btn').forEach(btn => btn.addEventListener('click', () => {
        selectedTheme = btn.dataset.theme;
        document.querySelectorAll('.theme-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
    }));

    document.querySelectorAll('.dither-btn').forEach(btn => btn.addEventListener('click', () => {
        selectedDither = btn.dataset.dither;
        document.querySelectorAll('.dither-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
    }));
    
    const lowInkCheck = $('lowInkCheckbox');
    if (lowInkCheck) {
        lowInkCheck.addEventListener('change', () => {
            isLowInk = lowInkCheck.checked;
        });
    }
    
    document.querySelectorAll('.color-btn').forEach(btn => btn.addEventListener('click', () => {
        drawColor = btn.dataset.color;
        document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        updateDrawContext();
    }));
    
    document.querySelectorAll('.brush-btn').forEach(btn => btn.addEventListener('click', () => {
        brushSize = parseInt(btn.dataset.size);
        document.querySelectorAll('.brush-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        updateDrawContext();
    }));
    
    const endSessionBtn = document.getElementById('endSessionBtn');
    if (endSessionBtn) endSessionBtn.addEventListener('click', () => { window.location.href = './session-summary.html'; });
    
    const dc = $('modalDrawCanvas');
    dc.addEventListener('mousedown', startDrawing);
    dc.addEventListener('mousemove', draw);
    dc.addEventListener('mouseup', stopDrawing);
    dc.addEventListener('mouseout', stopDrawing);
    dc.addEventListener('touchstart', handleTouch, {passive: false});
    dc.addEventListener('touchmove', handleTouch, {passive: false});
    dc.addEventListener('touchend', stopDrawing);
}

function updateDrawContext() {
    const dc = $('modalDrawCanvas');
    if (!dc) return;
    const ctx = dc.getContext('2d');
    ctx.strokeStyle = drawColor;
    ctx.lineWidth = brushSize;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
}

function startTimer() {
    if (!currentTask) {
        const ongoing = tasks.filter(t => t.status === 'ongoing');
        if (ongoing.length) currentTask = ongoing[0];
        else { alert('Select a task first'); return; }
    }
    if (!isRunning) {
        isRunning = true;
        taskStartTime = new Date();
        if (!currentTask.startTime) {
            currentTask.startTime = taskStartTime.getTime();
            saveTasks();
        }
        $('playBtn').disabled = true;
        $('pauseBtn').disabled = false;
        $('checkBtn').disabled = false;
        timerInterval = setInterval(() => { seconds++; updateTimerDisplay(); }, 1000);
    }
}

function pauseTimer() {
    if (isRunning) {
        clearInterval(timerInterval);
        isRunning = false;
        $('playBtn').disabled = false;
        $('pauseBtn').disabled = true;
        breaksTaken++;
        $('breaksCount').textContent = `${breaksTaken} breaks taken`;
        localStorage.setItem('tr_breaks', breaksTaken);
    }
}

function finishTask() {
    if (!currentTask) { alert('Select a task first'); return; }
    if (isRunning) {
        clearInterval(timerInterval);
        isRunning = false;
        $('playBtn').disabled = false;
        $('pauseBtn').disabled = true;
    }
    $('checkBtn').disabled = true;
    openModal();
}

function updateTimerDisplay() {
    const m = Math.floor(seconds / 60).toString().padStart(2, '0');
    const s = (seconds % 60).toString().padStart(2, '0');
    $('flipMin1').textContent = m[0]; $('flipMin2').textContent = m[1];
    $('flipSec1').textContent = s[0]; $('flipSec2').textContent = s[1];
    // Fire once per minute when the seconds counter rolls over to :00
    if (seconds > 0 && seconds % 60 === 0) SFX.minuteTick();
}

function toggleTaskInput() {
    const c = $('taskInputContainer');
    c.style.display = c.style.display === 'none' ? 'flex' : 'none';
    if (c.style.display === 'flex') $('taskInput').focus();
}

function addTask() {
    const name = $('taskInput').value.trim();
    if (name) {
        tasks.push({ id: Date.now(), name, status: 'ongoing', duration: 0 });
        saveTasks(); renderTasks();
        $('taskInput').value = '';
        $('taskInputContainer').style.display = 'none';
    }
}

function renderTasks() {
    const activeTab = document.querySelector('.tab.active').dataset.tab;
    const filtered = tasks.filter(t => activeTab === 'ongoing' ? t.status === 'ongoing' : t.status === 'completed');
    $('taskList').innerHTML = filtered.length ? filtered.map(task => `
        <div class="task-item ${task.status === 'completed' ? 'completed' : ''} ${currentTask?.id === task.id ? 'active' : ''}">
            <span>${task.name}</span>
            <div>${task.status === 'ongoing' ? `<button class="task-btn primary" onclick="selectTask(${task.id})">Select</button>` : `<button class="task-btn" onclick="viewReceipt(${task.id})">View</button>`}</div>
        </div>
    `).join('') : '<div class="no-tasks">No tasks yet. Hit + to add one.</div>';
}

function selectTask(id) { currentTask = tasks.find(t => t.id === id); renderTasks(); }
function switchTab(tab) { document.querySelectorAll('.tab').forEach(t => t.classList.remove('active')); document.querySelector(`[data-tab="${tab}"]`).classList.add('active'); renderTasks(); }

function loadTasks() { 
    const s = localStorage.getItem('tr_tasks'); 
    const positions = getHomePositions();
    breaksTaken = parseInt(localStorage.getItem('tr_breaks') || '0');
    $('breaksCount').textContent = `${breaksTaken} breaks taken`;
    if (s) { 
        tasks = JSON.parse(s); 
        receipts = [];
        tasks.forEach(t => {
            if (t.status === 'completed' && t.receiptImage) {
                receipts.push({ id: t.id, taskId: t.id, taskName: t.name, image: t.receiptImage, theme: t.receiptTheme || 'theme-white', style: t.receiptStyle || 'photo', date: new Date(t.id), duration: t.duration || 0, breaks: t.breaks || 0 });
            }
        });
        renderTasks();
        receipts.forEach(r => {
            const savedPos = positions[r.id];
            renderReceipt(r, true, savedPos);
        });
    } 
}

function saveTasks() { localStorage.setItem('tr_tasks', JSON.stringify(tasks)); }

async function openModal() { $('modalOverlay').style.display = 'flex'; switchModalView(); }

function switchModalView() {
    const drawingTools = $('drawingTools');
    if (cameraMode === 'photo') {
        if (drawingTools) drawingTools.style.display = 'none';
        navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false }).then(s => {
            stream = s;
            $('modalVideo').srcObject = s;
            $('modalVideo').style.display = 'block';
            $('modalDrawCanvas').style.display = 'none';
            $('modalVideo').onloadedmetadata = () => { $('modalVideo').play(); };
        }).catch(() => alert('Camera denied'));
    } else {
        if (drawingTools) drawingTools.style.display = 'flex';
        if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
        $('modalVideo').style.display = 'none';
        const dc = $('modalDrawCanvas');
        dc.style.display = 'block';
        const rect = dc.parentElement.getBoundingClientRect();
        dc.width = rect.width || 440;
        dc.height = rect.height || 260;
        const ctx = dc.getContext('2d');
        const existingData = ctx.getImageData(0, 0, dc.width, dc.height).data;
        const isEmpty = !Array.from(existingData).some(v => v !== 255 && v !== 0);
        if (isEmpty) {
            ctx.fillStyle = '#fff';
            ctx.fillRect(0, 0, dc.width, dc.height);
        }
        updateDrawContext();
    }
}

function closeModal() { if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; } $('modalOverlay').style.display = 'none'; }

function startDrawing(e) {
    isDrawing = true;
    const dc = $('modalDrawCanvas');
    const rect = dc.getBoundingClientRect();
    lastX = (e.clientX - rect.left) * (dc.width / rect.width);
    lastY = (e.clientY - rect.top) * (dc.height / rect.height);
}

function draw(e) {
    if (!isDrawing) return;
    const dc = $('modalDrawCanvas');
    const rect = dc.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (dc.width / rect.width);
    const y = (e.clientY - rect.top) * (dc.height / rect.height);
    const ctx = dc.getContext('2d');
    ctx.beginPath(); ctx.moveTo(lastX, lastY); ctx.lineTo(x, y); ctx.stroke();
    lastX = x; lastY = y;
}

function stopDrawing() { isDrawing = false; }

function handleTouch(e) {
    e.preventDefault();
    const touch = e.touches[0];
    const mouseEvent = new MouseEvent(e.type === 'touchstart' ? 'mousedown' : 'mousemove', { clientX: touch.clientX, clientY: touch.clientY });
    $('modalDrawCanvas').dispatchEvent(mouseEvent);
}

function updateCameraScreen(imageSrc) {
    const screenContainer = document.getElementById('cameraScreen');
    if (screenContainer) {
        screenContainer.innerHTML = '';
        const img = document.createElement('img');
        img.src = imageSrc;
        img.style.width = '100%';
        img.style.height = '100%';
        img.style.objectFit = 'cover';
        img.style.display = 'block';
        screenContainer.appendChild(img);
    }
}

function captureImage() {
    const flash = document.createElement('div');
    flash.className = 'flash-overlay';
    document.body.appendChild(flash);
    setTimeout(() => flash.remove(), 200);

    if (cameraMode === 'photo') {
        const video = $('modalVideo');
        if (!video.videoWidth || video.videoWidth === 0) {
            alert('Camera not ready. Please wait a moment and try again.');
            return;
        }
        const source = document.createElement('canvas');
        const ctx = source.getContext('2d');
        source.width = video.videoWidth;
        source.height = video.videoHeight;
        ctx.drawImage(video, 0, 0);
        const rawPhotoDataURL = source.toDataURL('image/png');
        if (currentTask) {
            if (selectedDither === 'dotmatrix') {
                currentTask.receiptImage = applyPhotoDotMatrix(source);
            } else {
                currentTask.receiptImage = applyDitherFilter(source, selectedDither, false, isLowInk);
            }
            currentTask.receiptTheme = selectedTheme;
            currentTask.receiptStyle = 'photo';
        }
        updateCameraScreen(rawPhotoDataURL);
    } else {
        const source = $('modalDrawCanvas');
        const ctx = source.getContext('2d');
        const imgData = ctx.getImageData(0, 0, source.width, source.height);
        const hasContent = Array.from(imgData.data).some((v, i) => {
            if (i % 4 === 3) return false;
            return v < 240;
        });
        if (!hasContent) {
            alert('Please draw something before capturing.');
            return;
        }
        const drawingDataURL = source.toDataURL('image/png');
        if (currentTask) {
            if (selectedDither === 'dotmatrix') {
                currentTask.receiptImage = applyDotMatrix(source, true);
            } else {
                currentTask.receiptImage = applyDitherFilter(source, selectedDither, true, isLowInk);
            }
            currentTask.receiptTheme = selectedTheme;
            currentTask.receiptStyle = 'draw';
        }
        updateCameraScreen(drawingDataURL);
    }
}

function applyPhotoDotMatrix(sourceCanvas) {
    const temp = document.createElement('canvas');
    const tCtx = temp.getContext('2d');
    const dotSize = 6;
    const spacing = 7;
    const gridW = 45;
    const gridH = 33;
    temp.width = gridW * spacing;
    temp.height = gridH * spacing;
    tCtx.drawImage(sourceCanvas, 0, 0, temp.width, temp.height);
    const imgData = tCtx.getImageData(0, 0, temp.width, temp.height);
    const data = imgData.data;
    const output = document.createElement('canvas');
    output.width = temp.width;
    output.height = temp.height;
    const oCtx = output.getContext('2d');
    oCtx.clearRect(0, 0, output.width, output.height);
    for (let gy = 0; gy < gridH; gy++) {
        for (let gx = 0; gx < gridW; gx++) {
            const px = Math.floor(gx * spacing + spacing / 2);
            const py = Math.floor(gy * spacing + spacing / 2);
            const idx = (py * temp.width + px) * 4;
            const r = data[idx], g = data[idx + 1], b = data[idx + 2];
            const brightness = (r + g + b) / 3;
            if (brightness < 160) {
                const cx = gx * spacing + spacing / 2;
                const cy = gy * spacing + spacing / 2;
                let radius = dotSize / 2;
                if (brightness < 60) radius = (dotSize / 2) + 1.2;
                else if (brightness < 100) radius = (dotSize / 2) + 0.6;
                else if (brightness < 140) radius = (dotSize / 2) + 0.2;
                oCtx.beginPath();
                oCtx.fillStyle = '#1a1a1a';
                oCtx.arc(cx, cy, radius, 0, Math.PI * 2);
                oCtx.fill();
            }
        }
    }
    const final = document.createElement('canvas');
    final.width = 200; final.height = 110;
    const fCtx = final.getContext('2d');
    fCtx.imageSmoothingEnabled = false;
    fCtx.drawImage(output, 0, 0, final.width, final.height);
    return final.toDataURL('image/png');
}

function applyDotMatrix(sourceCanvas, preserveColor = false) {
    const temp = document.createElement('canvas');
    const tCtx = temp.getContext('2d');
    const dotSize = 5;
    const spacing = 6;
    const gridW = 55;
    const gridH = 40;
    temp.width = gridW * spacing;
    temp.height = gridH * spacing;
    tCtx.drawImage(sourceCanvas, 0, 0, temp.width, temp.height);
    const imgData = tCtx.getImageData(0, 0, temp.width, temp.height);
    const data = imgData.data;
    const output = document.createElement('canvas');
    output.width = temp.width;
    output.height = temp.height;
    const oCtx = output.getContext('2d');
    oCtx.clearRect(0, 0, output.width, output.height);
    for (let gy = 0; gy < gridH; gy++) {
        for (let gx = 0; gx < gridW; gx++) {
            const px = Math.floor(gx * spacing + spacing / 2);
            const py = Math.floor(gy * spacing + spacing / 2);
            const idx = (py * temp.width + px) * 4;
            const r = data[idx], g = data[idx + 1], b = data[idx + 2];
            const isWhite = r > 245 && g > 245 && b > 245;
            if (!isWhite) {
                const cx = gx * spacing + spacing / 2;
                const cy = gy * spacing + spacing / 2;
                oCtx.beginPath();
                if (preserveColor) {
                    oCtx.fillStyle = `rgb(${r}, ${g}, ${b})`;
                } else {
                    oCtx.fillStyle = '#1a1a1a';
                }
                oCtx.arc(cx, cy, dotSize / 2, 0, Math.PI * 2);
                oCtx.fill();
            }
        }
    }
    const final = document.createElement('canvas');
    final.width = 200; final.height = 110;
    const fCtx = final.getContext('2d');
    fCtx.imageSmoothingEnabled = false;
    fCtx.drawImage(output, 0, 0, final.width, final.height);
    return final.toDataURL('image/png');
}

function applyDitherFilter(sourceCanvas, type, preserveColor = false, lowInk = false) {
    const temp = document.createElement('canvas');
    const tCtx = temp.getContext('2d');
    const gridW = 120;
    const gridH = 80;
    temp.width = gridW;
    temp.height = gridH;
    
    tCtx.drawImage(sourceCanvas, 0, 0, gridW, gridH);
    const imgData = tCtx.getImageData(0, 0, gridW, gridH);
    const data = imgData.data;
    
    const output = document.createElement('canvas');
    output.width = gridW;
    output.height = gridH;
    const oCtx = output.getContext('2d');
    oCtx.clearRect(0, 0, gridW, gridH);
    
    const getIndex = (x, y) => (y * gridW + x) * 4;
    
    const grayData = new Float32Array(gridW * gridH);
    for (let i = 0; i < data.length; i += 4) {
        grayData[i / 4] = 0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2];
    }
    
    if (type === 'floyd') {
        for (let y = 0; y < gridH; y++) {
            const isLowInkRow = lowInk && (Math.sin(y / 3) > 0.6 && Math.random() < 0.8 || Math.random() < 0.08);
            
            for (let x = 0; x < gridW; x++) {
                const idx = y * gridW + x;
                const pIdx = idx * 4;
                
                if (isLowInkRow) continue;
                
                const oldGray = grayData[idx];
                const newGray = oldGray < 128 ? 0 : 255;
                const err = oldGray - newGray;
                
                if (newGray === 0) {
                    oCtx.fillStyle = preserveColor ? `rgb(${data[pIdx]}, ${data[pIdx+1]}, ${data[pIdx+2]})` : '#1a1a1a';
                    oCtx.fillRect(x, y, 1, 1);
                }
                
                if (x + 1 < gridW)      grayData[idx + 1] += err * 7 / 16;
                if (x - 1 >= 0 && y + 1 < gridH) grayData[idx - 1 + gridW] += err * 3 / 16;
                if (y + 1 < gridH)      grayData[idx + gridW] += err * 5 / 16;
                if (x + 1 < gridW && y + 1 < gridH) grayData[idx + 1 + gridW] += err * 1 / 16;
            }
        }
    } else if (type === 'atkinson') {
        for (let y = 0; y < gridH; y++) {
            const isLowInkRow = lowInk && (Math.sin(y / 3) > 0.6 && Math.random() < 0.8 || Math.random() < 0.08);
            
            for (let x = 0; x < gridW; x++) {
                const idx = y * gridW + x;
                const pIdx = idx * 4;
                
                if (isLowInkRow) continue;
                
                const oldGray = grayData[idx];
                const newGray = oldGray < 128 ? 0 : 255;
                const err = (oldGray - newGray) / 8;
                
                if (newGray === 0) {
                    oCtx.fillStyle = preserveColor ? `rgb(${data[pIdx]}, ${data[pIdx+1]}, ${data[pIdx+2]})` : '#1a1a1a';
                    oCtx.fillRect(x, y, 1, 1);
                }
                
                const addErr = (nx, ny) => {
                    if (nx >= 0 && nx < gridW && ny >= 0 && ny < gridH) {
                        grayData[ny * gridW + nx] += err;
                    }
                };
                addErr(x + 1, y);
                addErr(x + 2, y);
                addErr(x - 1, y + 1);
                addErr(x, y + 1);
                addErr(x + 1, y + 1);
                addErr(x, y + 2);
            }
        }
    } else if (type === 'bayer') {
        const bayer = [
            [  0,  8,  2, 10 ],
            [ 12,  4, 14,  6 ],
            [  3, 11,  1,  9 ],
            [ 15,  7, 13,  5 ]
        ];
        
        for (let y = 0; y < gridH; y++) {
            const isLowInkRow = lowInk && (Math.sin(y / 3) > 0.6 && Math.random() < 0.8 || Math.random() < 0.08);
            
            for (let x = 0; x < gridW; x++) {
                const idx = y * gridW + x;
                const pIdx = idx * 4;
                
                if (isLowInkRow) continue;
                
                const oldGray = grayData[idx];
                const threshold = (bayer[y % 4][x % 4] + 0.5) * 16;
                
                if (oldGray < threshold) {
                    oCtx.fillStyle = preserveColor ? `rgb(${data[pIdx]}, ${data[pIdx+1]}, ${data[pIdx+2]})` : '#1a1a1a';
                    oCtx.fillRect(x, y, 1, 1);
                }
            }
        }
    }
    
    const finalCanvas = document.createElement('canvas');
    finalCanvas.width = 200;
    finalCanvas.height = 110;
    const fCtx = finalCanvas.getContext('2d');
    fCtx.imageSmoothingEnabled = false;
    fCtx.drawImage(output, 0, 0, finalCanvas.width, finalCanvas.height);
    return finalCanvas.toDataURL('image/png');
}

function signOff() {
    if (!currentTask || !currentTask.receiptImage) { alert('Capture first!'); return; }
    closeModal();
    currentTask.status = 'completed';
    currentTask.duration = seconds;
    currentTask.breaks = breaksTaken;
    if (!currentTask.startTime) {
        currentTask.startTime = (taskStartTime || new Date(Date.now() - seconds * 1000)).getTime();
    }
    saveTasks(); renderTasks();
    createReceipt();
    breaksTaken = 0;
    localStorage.setItem('tr_breaks', 0);
    $('breaksCount').textContent = `0 breaks taken`;
    seconds = 0; updateTimerDisplay();
}

function createReceipt() {
    const receipt = {
        id: Date.now(), taskId: currentTask.id, taskName: currentTask.name,
        image: currentTask.receiptImage, theme: currentTask.receiptTheme,
        style: currentTask.receiptStyle, date: new Date(),
        startTime: currentTask.startTime ? new Date(currentTask.startTime) : (taskStartTime || new Date(Date.now() - seconds * 1000)), 
        endTime: new Date(), duration: seconds, breaks: breaksTaken
    };
    receipts.push(receipt);
    renderReceipt(receipt);
}

function renderReceipt(receipt, skipAnimation = false, savedPos = null) {
    const rot = savedPos ? savedPos.rot : (Math.random() - 0.5) * 12;
    const el = document.createElement('div');
    el.className = `receipt ${receipt.theme}`;
    
    if (skipAnimation) {
        el.classList.add('settled');
        if (savedPos) {
            el.style.top = savedPos.top;
            el.style.left = savedPos.left;
            el.style.setProperty('--rot', `${savedPos.rot}deg`);
        }
    } else {
        el.style.setProperty('--rot', `${rot}deg`);
        el.style.visibility = 'hidden'; // Hide until positioned
    }
    
    const dateStr = receipt.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase();
    const timeStr = receipt.date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    const endTimeStr = receipt.endTime ? receipt.endTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : timeStr;
    const startStr = receipt.startTime ? receipt.startTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : timeStr;
    const onTask = receipt.duration > 0 ? '100%' : '0%';
    
    el.innerHTML = `
        <div class="receipt-top-row">
            <svg class="receipt-icon-small" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="2" width="14" height="20" rx="1"/><line x1="9" y1="6" x2="15" y2="6"/><line x1="9" y1="10" x2="15" y2="10"/><line x1="9" y1="14" x2="13" y2="14"/></svg>
            <span class="receipt-task-name">${receipt.taskName}</span>
        </div>
        <div class="receipt-date-row">${dateStr}, ${timeStr}</div>
        <div class="receipt-image-large"><img src="${receipt.image}" alt="proof"></div>
        <div class="receipt-dashed-sep"></div>
        <div class="receipt-timeline-row">
            <div class="receipt-time-block"></div>
            <span class="receipt-time-mid">${endTimeStr}</span>
            <span class="receipt-time-right">${onTask} on task</span>
        </div>
        <div class="receipt-bottom-row">
            <span>${startStr} Start ---></span>
            <span>1 square = 1 min${receipt.duration !== 60 ? 's' : ''}</span>
        </div>
        <button class="export-receipt-btn" data-html2canvas-ignore="true" onclick="exportReceipt(event, this)">Export Scan</button>
    `;
    
    $('receiptsArea').appendChild(el);

    if (!skipAnimation) {
        // ─ SMOOTH PRINTER ANIMATION ───────────────────────────────────────
        // The FULL receipt exists from frame 1. It starts hidden inside the slot,
        // feeds out, curls, falls, and lands. No swapping or placeholders.
        
        requestAnimationFrame(() => {
            const area = $('receiptsArea');
            const areaRect = area.getBoundingClientRect();
            const slotEl = document.querySelector('.printer-slot');
            
            // Measure slot position relative to receiptsArea
            let slotCX = areaRect.width / 2;
            let slotBottomY = 20; // Default fallback
            if (slotEl) {
                const sr = slotEl.getBoundingClientRect();
                slotCX = sr.left + sr.width / 2 - areaRect.left;
                slotBottomY = sr.bottom - areaRect.top;
            }

            const elW = el.offsetWidth || 175;
            const elH = el.offsetHeight || 280;

            // 1. START: Position receipt so its bottom edge is at the slot bottom.
            // It is fully clipped (hidden) inside the slot area.
            const startTop = slotBottomY - elH;
            const startLeft = slotCX - elW / 2;

            el.style.left = `${startLeft}px`;
            el.style.top = `${startTop}px`;
            el.style.transform = `rotate(0deg)`;
            el.style.visibility = 'visible';
            el.style.opacity = '1';
            el.style.clipPath = `inset(100% 0 0 0)`; // Fully hidden
            el.style.transition = 'none';

            // Force reflow to ensure initial state is applied
            void el.offsetWidth;

            // 2. FEED PHASE (1.5s): Move down and unclip simultaneously.
            // The receipt moves down by its full height, revealing itself.
            el.style.transition = `top 1.5s cubic-bezier(0.4, 0, 0.2, 1), clip-path 1.5s cubic-bezier(0.4, 0, 0.2, 1)`;
            el.style.top = `${startTop + elH}px`;
            el.style.clipPath = `inset(0 0 0 0)`; // Fully revealed
            SFX.printerStart(1500); // 🔊 Starts exactly with the feed, lasts exactly 1.5s

            // 3. FALL PHASE (after 1.5s): Curl and drop to landing spot.
            setTimeout(() => {
                if (el.classList.contains('dragging')) return;
                SFX.printerStop(100); // 🔊 Sound fades out as paper detaches from roller

                const landTop = slotBottomY + 40 + Math.random() * 80;
                const landLeft = slotCX - elW / 2 + (Math.random() - 0.5) * 60;

                el.style.transition = `top 0.8s cubic-bezier(0.5, 0, 1, 0.5), left 0.8s ease-out, transform 0.8s ease-in`;
                el.style.top = `${landTop}px`;
                el.style.left = `${landLeft}px`;
                el.style.transform = `rotate(${rot}deg)`;

                // 4. SETTLE: Lock position and enable floating animation.
                setTimeout(() => {
                    if (el.classList.contains('dragging')) return;
                    el.style.transition = 'none';
                    el.classList.add('settled');
                    saveHomePosition(receipt.id, el.style.top, el.style.left, rot);
                }, 800);
            }, 1500);
        });
    }
    
    let dragState = { active: false, moved: false, startX: 0, startY: 0, initX: 0, initY: 0 };
    let isExpanded = false;
    
    const onDown = (e) => {
        e.preventDefault();
        dragState.active = true;
        dragState.moved = false;
        const cx = e.touches ? e.touches[0].clientX : e.clientX;
        const cy = e.touches ? e.touches[0].clientY : e.clientY;
        dragState.startX = cx; dragState.startY = cy;
        dragState.initX = el.offsetLeft; dragState.initY = el.offsetTop;
        el.classList.remove('settled', 'expanded');
        el.style.animation = 'none';
        el.style.clipPath = 'none'; // Remove clip if dragging starts mid-animation
        const rect = el.getBoundingClientRect();
        const parent = $('receiptsArea').getBoundingClientRect();
        el.style.left = (rect.left - parent.left + rect.width/2) + 'px';
        el.style.top = (rect.top - parent.top + rect.height/2) + 'px';
        el.style.transform = `translate(-50%, -50%) rotate(${rot}deg)`;
        el.classList.add('dragging');
        isExpanded = false;
    };
    
    const onMove = (e) => {
        if (!dragState.active) return;
        const cx = e.touches ? e.touches[0].clientX : e.clientX;
        const cy = e.touches ? e.touches[0].clientY : e.clientY;
        if (Math.abs(cx - dragState.startX) > 4 || Math.abs(cy - dragState.startY) > 4) dragState.moved = true;
        if (dragState.moved) {
            el.style.left = `${dragState.initX + (cx - dragState.startX)}px`;
            el.style.top = `${dragState.initY + (cy - dragState.startY)}px`;
        }
    };
    
    const onUp = () => {
        if (!dragState.active) return;
        dragState.active = false;
        el.classList.remove('dragging');
        el.classList.add('settled');
        saveHomePosition(receipt.id, el.style.top, el.style.left, rot);
    };
    
    const onClick = () => {
        if (dragState.moved) { dragState.moved = false; return; }
        document.querySelectorAll('.receipt.expanded').forEach(other => { if (other !== el) other.classList.remove('expanded'); });
        isExpanded = !isExpanded;
        el.classList.toggle('expanded', isExpanded);
    };
    
    const onDocClick = (e) => { if (!el.contains(e.target) && isExpanded) { isExpanded = false; el.classList.remove('expanded'); } };
    
    el.addEventListener('mousedown', onDown);
    el.addEventListener('touchstart', onDown, {passive: false});
    document.addEventListener('mousemove', onMove);
    document.addEventListener('touchmove', onMove, {passive: false});
    document.addEventListener('mouseup', onUp);
    document.addEventListener('touchend', onUp);
    el.addEventListener('click', onClick);
    document.addEventListener('click', onDocClick);
}

function viewReceipt(id) { const r = receipts.find(r => r.taskId === id); if (r) renderReceipt(r); }

function exportReceipt(event, btn) {
    event.stopPropagation();
    const receiptEl = btn.closest('.receipt') || btn.closest('.summary-receipt');
    if (!receiptEl) return;

    const container = document.createElement('div');
    container.style.position = 'fixed';
    container.style.top = '-9999px';
    container.style.left = '-9999px';
    container.style.width = '800px';
    container.style.height = '600px';
    container.style.display = 'flex';
    container.style.alignItems = 'center';
    container.style.justifyContent = 'center';
    container.style.overflow = 'hidden';
    container.style.background = 'radial-gradient(circle, #2d1a10 0%, #150b06 100%)';
    
    const vignette = document.createElement('div');
    vignette.style.position = 'absolute';
    vignette.style.top = '0';
    vignette.style.left = '0';
    vignette.style.width = '100%';
    vignette.style.height = '100%';
    vignette.style.background = 'radial-gradient(ellipse at center, rgba(0,0,0,0) 30%, rgba(0,0,0,0.65) 100%)';
    vignette.style.pointerEvents = 'none';
    vignette.style.zIndex = '5';
    container.appendChild(vignette);

    const clone = receiptEl.cloneNode(true);
    clone.classList.remove('expanded', 'settled', 'dragging');
    clone.style.position = 'relative';
    clone.style.top = '0';
    clone.style.left = '0';
    const angle = -3 - Math.random() * 2;
    clone.style.transform = `rotate(${angle}deg)`;
    clone.style.boxShadow = '12px 16px 28px rgba(0,0,0,0.5)';
    clone.style.zIndex = '2';
    clone.style.visibility = 'visible';
    clone.style.opacity = '1';
    clone.style.clipPath = 'none';
    
    container.appendChild(clone);
    document.body.appendChild(container);

    html2canvas(container, {
        width: 800,
        height: 600,
        scale: 2,
        useCORS: true,
        allowTaint: true
    }).then(canvas => {
        const link = document.createElement('a');
        link.download = `receipt-${Date.now()}.png`;
        link.href = canvas.toDataURL('image/png');
        link.click();
        container.remove();
    }).catch(err => {
        console.error('Export failed:', err);
        alert('Could not export receipt.');
        container.remove();
    });
}

window.selectTask = selectTask;
window.viewReceipt = viewReceipt;
window.exportReceipt = exportReceipt;