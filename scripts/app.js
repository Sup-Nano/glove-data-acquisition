        // ==================== 配置 ====================
        const CONFIG = {
            BAUDRATE: 115200,
            EXPECTED_FIELDS: 46,
            MPU_ACC_SCALE: 4096.0,
            MPU_GYRO_SCALE: 32.8
        };

        // ==================== 状态 ====================
        let history = [];
        let isPaused = false;
        let isRecording = false;
        let isCollecting = false;     // 新增：下位机是否正在采集发送数据
        let frameCount = 0;
        let recordedCount = 0;
        let errorCount = 0;
        let fps = 0;
        let frameCounter = 0;
        let lastFrameTime = performance.now();
        let connectStartTime = null;
        let acquireStartTime = null;
        let currentTheme = 'dark';

        // Zoom 状态
        let zoomType = null;
        let zoomIdx = null;
        let zoomChart = null;
        let zoomSourceChart = null;

        // ==================== 图表类 ====================
        class LineChart {
            constructor(canvasId, colors, maxPoints = 300) {
                this.canvas = document.getElementById(canvasId);
                this.ctx = this.canvas.getContext('2d');
                this.colors = colors;
                this.lines = colors.map(c => ({ color: c, data: [] }));
                this.maxPoints = maxPoints;
                this.resize();
                window.addEventListener('resize', () => this.resize());
            }
            resize() {
                const rect = this.canvas.getBoundingClientRect();
                const dpr = window.devicePixelRatio || 1;
                this.canvas.width = rect.width * dpr;
                this.canvas.height = rect.height * dpr;
                this.ctx.scale(dpr, dpr);
                this.width = rect.width;
                this.height = rect.height;
            }
            addPoint(values) {
                if (isPaused) return;
                this.lines.forEach((line, i) => {
                    line.data.push(values[i]);
                    if (line.data.length > this.maxPoints) line.data.shift();
                });
            }
            draw() {
                const ctx = this.ctx, w = this.width, h = this.height;
                const pad = {top: 8, right: 6, bottom: 18, left: 32};
                const isLight = document.body.classList.contains('light-theme');
                ctx.clearRect(0, 0, w, h);

                let min = Infinity, max = -Infinity;
                this.lines.forEach(l => l.data.forEach(v => {
                    if (isFinite(v)) { if (v < min) min = v; if (v > max) max = v; }
                }));
                if (!isFinite(min) || min === max) { min = -1; max = 1; }
                const range = max - min;

                const axisColor = isLight ? '#64748b' : '#cbd5e1';
                ctx.strokeStyle = axisColor; ctx.lineWidth = 1; ctx.beginPath();
                const bottomY = h - pad.bottom;
                // 保留底部轴线，去除顶部和中间网格线
                ctx.moveTo(pad.left, bottomY); ctx.lineTo(w - pad.right, bottomY);
                // 左侧坐标轴
                ctx.moveTo(pad.left, pad.top); ctx.lineTo(pad.left, h - pad.bottom);
                ctx.stroke();

                ctx.fillStyle = isLight ? '#334155' : '#ffffff';
                ctx.font = '11px monospace';
                ctx.textAlign = 'right';
                for (let i = 0; i <= 3; i++) {
                    const val = max - range * i / 3;
                    ctx.fillText(val.toFixed(1), pad.left - 4, pad.top + (h - pad.top - pad.bottom) * i / 3 + 3);
                }

                this.lines.forEach(line => {
                    if (line.data.length < 2) return;
                    ctx.strokeStyle = line.color; ctx.lineWidth = 1.2; ctx.beginPath();
                    line.data.forEach((v, i) => {
                        const x = pad.left + (w - pad.left - pad.right) * (i / (this.maxPoints - 1));
                        const y = pad.top + (h - pad.top - pad.bottom) * (1 - (v - min) / range);
                        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
                    });
                    ctx.stroke();
                });
            }
        }

        // ==================== 初始化图表 ====================
        const pressureCharts = [
            new LineChart('canvas-pressure-thumb', ['#78350f','#92400e','#b45309','#d97706','#f59e0b','#fbbf24','#fcd34d','#fde68a','#fef3c7']),
            new LineChart('canvas-pressure-index', ['#172554','#1e3a8a','#1e40af','#2563eb','#3b82f6','#60a5fa','#93c5fd','#bfdbfe','#dbeafe']),
            new LineChart('canvas-pressure-middle', ['#450a0a','#7f1d1d','#991b1b','#b91c1c','#dc2626','#ef4444','#f87171','#fca5a5','#fecaca'])
        ];

        const strainCharts = [
            new LineChart('canvas-strain-thumb', ['#d97706', '#fcd34d']),
            new LineChart('canvas-strain-index', ['#2563eb', '#93c5fd']),
            new LineChart('canvas-strain-middle', ['#b91c1c', '#fca5a5'])
        ];

        const wristChart = new LineChart('canvas-imu-wrist', ['#ef4444','#f97316','#eab308','#22c55e','#06b6d4','#3b82f6']);
        const backChart = new LineChart('canvas-imu-back', ['#a855f7','#ec4899','#f43f5e','#8b5cf6','#6366f1','#0ea5e9']);

        // ==================== 放大功能（图表）====================
        function openZoom(type, idx) {
            let chart;
            let title;
            if (type === 'pressure') {
                chart = pressureCharts[idx];
                title = ['拇指指肚压力', '食指指肚压力', '中指指肚压力'][idx];
            } else if (type === 'strain') {
                chart = strainCharts[idx];
                title = ['拇指关节应变', '食指关节应变', '中指关节应变'][idx];
            } else if (type === 'imu') {
                chart = (idx === 0) ? wristChart : backChart;
                title = (idx === 0) ? '手腕 IMU (MPU#1)' : '手背 IMU (MPU#2)';
            }
            
            zoomSourceChart = chart;
            zoomType = type;
            zoomIdx = idx;
            
            document.getElementById('zoom-title').textContent = '🔍 ' + title;
            const modal = document.getElementById('zoom-modal');
            modal.style.display = 'flex';
            
            const grid = document.getElementById('zoom-data-grid');
            grid.innerHTML = '';
            grid.className = 'zoom-data-grid ' + type;
            
            let labels, colors;
            if (type === 'pressure') {
                labels = Array.from({length:9},(_,i)=>`P${i}`);
                colors = pressureCharts[idx].colors;
            } else if (type === 'strain') {
                labels = ['近端','远端'];
                colors = strainCharts[idx].colors;
            } else if (type === 'imu') {
                labels = ['Ax','Ay','Az','Gx','Gy','Gz'];
                colors = (idx === 0) ? ['#ef4444','#f97316','#eab308','#22c55e','#06b6d4','#3b82f6'] : ['#a855f7','#ec4899','#f43f5e','#8b5cf6','#6366f1','#0ea5e9'];
            }
            
            labels.forEach((label, i) => {
                const div = document.createElement('div');
                div.className = 'zoom-data-cell';
                div.innerHTML = `<span class="z-label" style="color:${colors[i]}">${label}</span><span class="z-value" id="zoom-v${i}">--</span>`;
                grid.appendChild(div);
            });
            
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    const zoomCanvas = document.getElementById('zoom-canvas');
                    const rect = zoomCanvas.getBoundingClientRect();
                    const dpr = window.devicePixelRatio || 1;
                    zoomCanvas.width = rect.width * dpr;
                    zoomCanvas.height = rect.height * dpr;
                    const ctx = zoomCanvas.getContext('2d');
                    ctx.scale(dpr, dpr);
                    
                    zoomChart = {
                        canvas: zoomCanvas, ctx: ctx,
                        width: rect.width, height: rect.height,
                        lines: chart.lines,
                        maxPoints: chart.maxPoints,
                        draw: function() {
                            const ctx = this.ctx, w = this.width, h = this.height;
                            const pad = {top: 16, right: 16, bottom: 44, left: 56};
                            const isLight = document.body.classList.contains('light-theme');
                            ctx.clearRect(0, 0, w, h);

                            let min = Infinity, max = -Infinity;
                            this.lines.forEach(l => l.data.forEach(v => {
                                if (isFinite(v)) { if (v < min) min = v; if (v > max) max = v; }
                            }));
                            if (!isFinite(min) || min === max) { min = -1; max = 1; }
                            const range = max - min;

                            ctx.strokeStyle = '#1e293b'; ctx.lineWidth = 1; ctx.beginPath();
                            for (let i = 0; i <= 4; i++) {
                                const y = pad.top + (h - pad.top - pad.bottom) * i / 4;
                                ctx.moveTo(pad.left, y); ctx.lineTo(w - pad.right, y);
                            }
                            const xTicks = 6;
                            for (let i = 0; i < xTicks; i++) {
                                const x = pad.left + (w - pad.left - pad.right) * (i / (xTicks - 1));
                                ctx.moveTo(x, pad.top); ctx.lineTo(x, h - pad.bottom);
                            }
                            ctx.stroke();

                            ctx.fillStyle = isLight ? '#334155' : '#ffffff'; ctx.font = 'bold 15px monospace'; ctx.textAlign = 'right';
                            for (let i = 0; i <= 4; i++) {
                                const val = max - range * i / 4;
                                ctx.fillText(val.toFixed(2), pad.left - 8, pad.top + (h - pad.top - pad.bottom) * i / 4 + 5);
                            }

                            const xAxisY = h - pad.bottom;
                            ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 2; ctx.beginPath();
                            ctx.moveTo(pad.left, xAxisY); ctx.lineTo(w - pad.right, xAxisY);
                            ctx.moveTo(pad.left, pad.top); ctx.lineTo(pad.left, xAxisY);
                            ctx.stroke();

                            ctx.fillStyle = '#94a3b8'; ctx.font = 'bold 12px monospace'; ctx.textAlign = 'center';
                            const currentFps = Math.max(fps, 1);
                            const currentPoints = Math.max(2, ...this.lines.map(line => line.data.length || 0));
                            const timeSpan = (currentPoints - 1) / currentFps;
                            const nowMs = Date.now();
                            for (let i = 0; i < xTicks; i++) {
                                const ratio = i / (xTicks - 1);
                                const x = pad.left + (w - pad.left - pad.right) * ratio;
                                ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 2; ctx.beginPath();
                                ctx.moveTo(x, xAxisY); ctx.lineTo(x, xAxisY + 6); ctx.stroke();
                                const secAgo = timeSpan * (1 - ratio);
                                const tickMs = nowMs - secAgo * 1000;
                                ctx.fillText(formatBeijingClock(tickMs), x, xAxisY + 24);
                            }

                            this.lines.forEach(line => {
                                if (line.data.length < 2) return;
                                ctx.strokeStyle = line.color; ctx.lineWidth = 2; ctx.beginPath();
                                line.data.forEach((v, i) => {
                                    const x = pad.left + (w - pad.left - pad.right) * (i / (this.maxPoints - 1));
                                    const y = pad.top + (h - pad.top - pad.bottom) * (1 - (v - min) / range);
                                    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
                                });
                                ctx.stroke();
                            });
                        }
                    };
                });
            });
        }

        function closeZoom() {
            document.getElementById('zoom-modal').style.display = 'none';
            zoomChart = null;
            zoomSourceChart = null;
            zoomType = null;
            zoomIdx = null;
        }

        // ==================== 放大功能（手部映射）====================
        function openHandMapZoom() {
            document.getElementById('hand-map-modal').style.display = 'flex';
        }
        function closeHandMapZoom() {
            document.getElementById('hand-map-modal').style.display = 'none';
        }

        // ESC 关闭所有模态框
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                closeZoom();
                closeHandMapZoom();
            }
        });

        // ==================== 初始化数值显示区域 ====================
        function createValueGrid(containerId, labels, colors) {
            const container = document.getElementById(containerId);
            labels.forEach((label, i) => {
                const div = document.createElement('div');
                div.className = 'data-cell';
                div.innerHTML = `<span class="label" style="color:${colors[i]||'#475569'}">${label}</span><span class="value" id="${containerId}-v${i}">--</span>`;
                container.appendChild(div);
            });
        }

        ['vals-pressure-thumb','vals-pressure-index','vals-pressure-middle'].forEach((id, idx) => {
            const names = Array.from({length:9},(_,i)=>`P${i}`);
            createValueGrid(id, names, pressureCharts[idx].colors);
        });

        createValueGrid('vals-strain-thumb', ['近端','远端'], ['#d97706','#fcd34d']);
        createValueGrid('vals-strain-index', ['近端','远端'], ['#2563eb','#93c5fd']);
        createValueGrid('vals-strain-middle', ['近端','远端'], ['#b91c1c','#fca5a5']);

        createValueGrid('vals-imu-wrist', ['Ax','Ay','Az','Gx','Gy','Gz'], ['#ef4444','#f97316','#eab308','#22c55e','#06b6d4','#3b82f6']);
        createValueGrid('vals-imu-back', ['Ax','Ay','Az','Gx','Gy','Gz'], ['#a855f7','#ec4899','#f43f5e','#8b5cf6','#6366f1','#0ea5e9']);

        // ==================== 初始化变色方阵 ====================
        function initMatrix(containerId) {
            const container = document.getElementById(containerId);
            for (let i = 0; i < 9; i++) {
                const cell = document.createElement('div');
                cell.className = 'cell';
                container.appendChild(cell);
            }
        }
        initMatrix('matrix-thumb');
        initMatrix('matrix-index');
        initMatrix('matrix-middle');
        initMatrix('zoom-matrix-thumb');
        initMatrix('zoom-matrix-index');
        initMatrix('zoom-matrix-middle');

        // ==================== 初始化 IMU 柱状图 ====================
        function initImuBars(containerId, colors) {
            const container = document.getElementById(containerId);
            const labels = ['Ax','Ay','Az','Gx','Gy','Gz'];
            labels.forEach((label, i) => {
                const wrap = document.createElement('div');
                wrap.className = 'imu-bar-item-v7';
                wrap.innerHTML = `
                    <div class="imu-bar-label-v7" style="color:${colors[i]}">${label}</div>
                    <div class="imu-bar-track-v7">
                        <div class="imu-bar-fill-v7" id="${containerId}-fill${i}" style="background:${colors[i]}"></div>
                    </div>
                    <div class="imu-bar-value-v7" id="${containerId}-v${i}">--</div>
                `;
                container.appendChild(wrap);
            });
        }
        const wristImuColors = ['#ef4444','#f97316','#eab308','#22c55e','#06b6d4','#3b82f6'];
        const backImuColors = ['#a855f7','#ec4899','#f43f5e','#8b5cf6','#6366f1','#0ea5e9'];
        initImuBars('imu-bars-wrist', wristImuColors);
        initImuBars('imu-bars-back', backImuColors);
        initImuBars('zoom-imu-bars-wrist', wristImuColors);
        initImuBars('zoom-imu-bars-back', backImuColors);

        // ==================== 更新数值显示 ====================
        function updateValues(containerId, values) {
            values.forEach((v, i) => {
                const el = document.getElementById(`${containerId}-v${i}`);
                if (el) el.textContent = (typeof v === 'number' ? v.toFixed(3) : v);
            });
        }

        // ==================== 更新 IMU 柱状图 ====================
        function updateImuBars(containerId, values) {
            values.forEach((v, i) => {
                const fill = document.getElementById(`${containerId}-fill${i}`);
                const valEl = document.getElementById(`${containerId}-v${i}`);
                if (fill) {
                    const absV = Math.abs(v);
                    const maxRef = (i < 3) ? 4.0 : 500.0;
                    const trackH = 60;
                    const h = Math.min(trackH, Math.max(2, (absV / maxRef) * trackH));
                    fill.style.height = h + 'px';
                }
                if (valEl) valEl.textContent = (typeof v === 'number' ? v.toFixed(2) : v);
            });
        }

        // ==================== 更新手部映射 ====================
        function updateHandMap(strain, pressure, wristAcc, wristGyro, backAcc, backGyro, prefix = '') {
            const getId = (id) => prefix ? `${prefix}-${id}` : id;
            
            const strainMax = 5.0;
            const barH = (v) => Math.max(8, Math.min(110, (v / strainMax) * 110)) + 'px';
            document.getElementById(getId('bar-thumb-p')).style.height = barH(strain[0]);
            document.getElementById(getId('bar-thumb-d')).style.height = barH(strain[1]);
            document.getElementById(getId('bar-index-p')).style.height = barH(strain[2]);
            document.getElementById(getId('bar-index-d')).style.height = barH(strain[3]);
            document.getElementById(getId('bar-middle-p')).style.height = barH(strain[4]);
            document.getElementById(getId('bar-middle-d')).style.height = barH(strain[5]);

            updateMatrix(getId('matrix-thumb'), pressure[0]);
            updateMatrix(getId('matrix-index'), pressure[1]);
            updateMatrix(getId('matrix-middle'), pressure[2]);

            updateImuBars(getId('imu-bars-wrist'), [...wristAcc, ...wristGyro]);
            updateImuBars(getId('imu-bars-back'), [...backAcc, ...backGyro]);
        }

        function updateMatrix(containerId, values) {
            const container = document.getElementById(containerId);
            if (!container) return;
            const maxVal = Math.max(...values, 0.001);
            const minVal = Math.min(...values, 0);
            const range = maxVal - minVal || 1;
            values.forEach((v, i) => {
                const cell = container.children[i];
                if (!cell) return;
                const norm = (v - minVal) / range;
                const r = Math.floor(norm * 255);
                const b = Math.floor((1 - norm) * 200);
                const g = Math.floor(norm * 80);
                cell.style.background = `rgb(${r}, ${g}, ${b + 40})`;
                cell.style.borderColor = `rgba(${r}, ${g}, ${b + 40}, 0.9)`;
                cell.style.boxShadow = norm > 0.6 ? `0 0 10px rgba(${r}, ${g}, ${b + 40}, 0.5)` : 'none';
            });
        }

        // ==================== 更新 Zoom 数据 ====================
        function updateZoomData(pressure, strain, mpu1_acc, mpu1_gyro, mpu2_acc, mpu2_gyro) {
            if (!zoomType) return;
            let values;
            if (zoomType === 'pressure') values = pressure[zoomIdx];
            else if (zoomType === 'strain') values = [strain[zoomIdx*2], strain[zoomIdx*2+1]];
            else if (zoomType === 'imu') values = (zoomIdx === 0) ? [...mpu1_acc, ...mpu1_gyro] : [...mpu2_acc, ...mpu2_gyro];
            
            values.forEach((v, i) => {
                const el = document.getElementById(`zoom-v${i}`);
                if (el) el.textContent = (typeof v === 'number' ? v.toFixed(3) : v);
            });
        }

        // ==================== 时长格式化 ====================
        function formatDuration(ms) {
            if (!ms || ms < 0) return '00:00:00';
            const totalSeconds = Math.floor(ms / 1000);
            const h = Math.floor(totalSeconds / 3600);
            const m = Math.floor((totalSeconds % 3600) / 60);
            const s = totalSeconds % 60;
            return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
        }

        // 生成严格北京时间（Asia/Shanghai），格式：年-月-日-小时-分-秒.xx
        function formatWorldTime() {
            const now = new Date();
            const parts = new Intl.DateTimeFormat('zh-CN', {
                timeZone: 'Asia/Shanghai',
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: false
            }).formatToParts(now);
            const getPart = (type) => parts.find(p => p.type === type)?.value || '00';
            const year = getPart('year');
            const month = getPart('month');
            const day = getPart('day');
            const hour = getPart('hour');
            const minute = getPart('minute');
            const secondInt = getPart('second');
            const centiseconds = String(Math.floor(now.getMilliseconds() / 10)).padStart(2, '0');
            const second = `${secondInt}.${centiseconds}`;
            return `${year}-${month}-${day}-${hour}-${minute}-${second}`;
        }

        function applyTheme(theme) {
            currentTheme = theme === 'light' ? 'light' : 'dark';
            document.body.classList.toggle('light-theme', currentTheme === 'light');
            const btn = document.getElementById('btn-theme');
            if (btn) btn.textContent = currentTheme === 'light' ? '暗色模式' : '浅色模式';
            const splashBtn = document.getElementById('splash-theme-btn');
            if (splashBtn) splashBtn.textContent = currentTheme === 'light' ? '暗色模式' : '浅色模式';
            localStorage.setItem('theme-preference', currentTheme);
        }

        function toggleTheme() {
            applyTheme(currentTheme === 'light' ? 'dark' : 'light');
        }

        // 将时间戳格式化为北京时间时分秒（HH:MM:SS.xx）
        function formatBeijingClock(ms) {
            const date = new Date(ms);
            const parts = new Intl.DateTimeFormat('zh-CN', {
                timeZone: 'Asia/Shanghai',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: false
            }).formatToParts(date);
            const getPart = (type) => parts.find(p => p.type === type)?.value || '00';
            const hour = getPart('hour');
            const minute = getPart('minute');
            const secondInt = getPart('second');
            const centiseconds = String(Math.floor(date.getMilliseconds() / 10)).padStart(2, '0');
            return `${hour}:${minute}:${secondInt}.${centiseconds}`;
        }

        setInterval(() => {
            const now = Date.now();
            document.getElementById('conn-duration').textContent = connectStartTime ? formatDuration(now - connectStartTime) : '00:00:00';
            document.getElementById('acq-duration').textContent = acquireStartTime ? formatDuration(now - acquireStartTime) : '00:00:00';
        }, 1000);

        // ==================== 采集控制（向下位机发送指令）====================
        async function toggleCollect() {
            if (!serial.connected) {
                addLogDebug('请先连接串口');
                return;
            }
            const btn = document.getElementById('btn-collect');
            if (!isCollecting) {
                await serial.write('start');
                isCollecting = true;
                btn.textContent = '停止采集';
                btn.className = 'btn-danger';
                addLogDebug('▶ 向下位机发送 start');
            } else {
                await serial.write('stop');
                isCollecting = false;
                btn.textContent = '开始采集';
                btn.className = 'btn-primary';
                addLogDebug('⏹ 向下位机发送 stop');
            }
        }

        // ==================== 记录控制（前端缓存）====================
        function toggleRecord() {
            isRecording = !isRecording;
            const btn = document.getElementById('btn-record');
            if (isRecording) {
                btn.textContent = '停止记录';
                btn.style.background = '#7f1d1d';
                btn.style.color = '#fff';
                btn.style.borderColor = '#991b1b';
                if (!acquireStartTime) acquireStartTime = Date.now();
                addLogDebug('▶ 开始记录数据到缓存');
            } else {
                btn.textContent = '开始记录';
                btn.style.background = '';
                btn.style.color = '';
                btn.style.borderColor = '';
                addLogDebug('⏹ 停止记录数据');
            }
        }

        // ==================== CSV 解析器 ====================
        class CsvParser {
            constructor() { this.buffer = ''; this.decoder = new TextDecoder('utf-8'); }
            feed(chunk) {
                this.buffer += this.decoder.decode(chunk, {stream: true});
                let lines = this.buffer.split('\n');
                this.buffer = lines.pop();
                lines.forEach(line => {
                    line = line.trim().replace(/\r$/, '');
                    if (!line) return;
                    const parts = line.split(',');
                    if (parts.length === CONFIG.EXPECTED_FIELDS && /^\d/.test(parts[0])) {
                        this.parseData(parts);
                        addLogData(line.substring(0, 90) + (line.length > 90 ? '...' : ''));
                    } else {
                        addLogDebug(line);
                    }
                });
            }
            parseData(parts) {
                try {
                    const timestamp = parseInt(parts[0]);
                    const strain = parts.slice(1, 7).map(v => parseFloat(v));
                    const pressureFlat = parts.slice(7, 34).map(v => parseFloat(v));
                    const pressure = [
                        pressureFlat.slice(0, 9),
                        pressureFlat.slice(9, 18),
                        pressureFlat.slice(18, 27)
                    ];

                    const mpu1_acc = parts.slice(34, 37).map(v => parseInt(v) / CONFIG.MPU_ACC_SCALE);
                    const mpu1_gyro = parts.slice(37, 40).map(v => parseInt(v) / CONFIG.MPU_GYRO_SCALE);
                    const mpu2_acc = parts.slice(40, 43).map(v => parseInt(v) / CONFIG.MPU_ACC_SCALE);
                    const mpu2_gyro = parts.slice(43, 46).map(v => parseInt(v) / CONFIG.MPU_GYRO_SCALE);

                    const imu_wrist = { accel: mpu1_acc, gyro: mpu1_gyro };
                    const imu_back = { accel: mpu2_acc, gyro: mpu2_gyro };
                    const frame = { timestamp, strain, pressure, imu_wrist, imu_back, time: formatWorldTime() };

                    if (!isPaused) {
                        if (isRecording) {
                            if (!acquireStartTime) acquireStartTime = Date.now();
                            history.push(frame);
                            recordedCount++;
                            document.getElementById('recorded-frames').textContent = recordedCount;
                            document.getElementById('buf-size').textContent = history.length;
                        }

                        pressureCharts[0].addPoint(pressure[0]);
                        pressureCharts[1].addPoint(pressure[1]);
                        pressureCharts[2].addPoint(pressure[2]);
                        updateValues('vals-pressure-thumb', pressure[0]);
                        updateValues('vals-pressure-index', pressure[1]);
                        updateValues('vals-pressure-middle', pressure[2]);

                        strainCharts[0].addPoint([strain[0], strain[1]]);
                        strainCharts[1].addPoint([strain[2], strain[3]]);
                        strainCharts[2].addPoint([strain[4], strain[5]]);
                        updateValues('vals-strain-thumb', [strain[0], strain[1]]);
                        updateValues('vals-strain-index', [strain[2], strain[3]]);
                        updateValues('vals-strain-middle', [strain[4], strain[5]]);

                        wristChart.addPoint([...mpu1_acc, ...mpu1_gyro]);
                        backChart.addPoint([...mpu2_acc, ...mpu2_gyro]);
                        updateValues('vals-imu-wrist', [...mpu1_acc, ...mpu1_gyro]);
                        updateValues('vals-imu-back', [...mpu2_acc, ...mpu2_gyro]);

                        updateHandMap(strain, pressure, mpu1_acc, mpu1_gyro, mpu2_acc, mpu2_gyro);
                        if (document.getElementById('hand-map-modal').style.display === 'flex') {
                            updateHandMap(strain, pressure, mpu1_acc, mpu1_gyro, mpu2_acc, mpu2_gyro, 'zoom');
                        }

                        if (zoomType) {
                            updateZoomData(pressure, strain, mpu1_acc, mpu1_gyro, mpu2_acc, mpu2_gyro);
                        }
                    }
                    frameCount++; frameCounter++;
                    document.getElementById('total-frames').textContent = frameCount;
                    document.getElementById('err-lines').textContent = errorCount;
                } catch (e) {
                    errorCount++;
                    addLogDebug(`解析错误: ${e.message}`);
                }
            }
        }

        // ==================== 串口连接（含写入功能）====================
        class SerialConnection {
            constructor() {
                this.port = null; this.reader = null;
                this.parser = new CsvParser(); this.connected = false;
            }
            async connect() {
                if (!navigator.serial) { alert('请使用 Chrome/Edge 浏览器'); return; }
                try {
                    this.port = await navigator.serial.requestPort();
                    await this.port.open({ baudRate: CONFIG.BAUDRATE });
                    this.connected = true;
                    connectStartTime = Date.now();
                    updateConnectionUI(true);
                    addLogDebug(`串口已连接 @ ${CONFIG.BAUDRATE}bps`);
                    // 启用采集按钮
                    document.getElementById('btn-collect').disabled = false;
                    this.readLoop();
                } catch (e) { addLogDebug(`连接失败: ${e.message}`); }
            }
            async readLoop() {
                this.reader = this.port.readable.getReader();
                try {
                    while (this.connected) {
                        const { value, done } = await this.reader.read();
                        if (done) break;
                        if (value) this.parser.feed(value);
                    }
                } catch (e) {
                    if (this.connected) {
                        addLogDebug(`读取异常/设备断开: ${e.message}`);
                        await this.disconnect();
                    }
                } finally {
                    if (this.reader) {
                        try { this.reader.releaseLock(); } catch(e) {}
                        this.reader = null;
                    }
                }
            }
            async write(data) {
                if (!this.port || !this.connected) return;
                const encoder = new TextEncoder();
                const writer = this.port.writable.getWriter();
                try {
                    await writer.write(encoder.encode(data + '\n'));
                } catch (e) {
                    addLogDebug(`写入失败: ${e.message}`);
                } finally {
                    writer.releaseLock();
                }
            }
            async disconnect() {
                this.connected = false;
                connectStartTime = null;
                acquireStartTime = null;
                // 重置采集状态
                isCollecting = false;
                const btn = document.getElementById('btn-collect');
                btn.textContent = '开始采集';
                btn.className = 'btn-primary';
                btn.disabled = true;
                if (this.reader) {
                    try { await this.reader.cancel(); } catch(e) {}
                }
                if (this.port) {
                    try { await this.port.close(); } catch(e) {}
                }
                this.port = null; this.reader = null;
                updateConnectionUI(false);
                addLogDebug('串口已断开');
            }
        }
        const serial = new SerialConnection();

        // ==================== UI 辅助 ====================
        function updateConnectionUI(connected) {
            document.getElementById('conn-dot').className = 'status-dot ' + (connected ? 'active' : '');
            document.getElementById('conn-text').textContent = connected ? '已连接' : '未连接';
            document.getElementById('btn-connect').disabled = connected;
            document.getElementById('btn-disconnect').disabled = !connected;
        }
        function addLogData(msg) {
            const container = document.getElementById('logData');
            const entry = document.createElement('div');
            entry.className = 'log-entry data';
            const time = new Date().toLocaleTimeString('zh-CN', {hour12:false});
            entry.innerHTML = `<span class="timestamp">[${time}]</span>${msg}`;
            container.appendChild(entry);
            container.scrollTop = container.scrollHeight;
            document.getElementById('data-log-count').textContent = container.children.length + ' 条';
            if (container.children.length > 300) container.removeChild(container.firstChild);
        }
        function addLogDebug(msg) {
            const container = document.getElementById('logDebug');
            const entry = document.createElement('div');
            entry.className = 'log-entry debug';
            const time = new Date().toLocaleTimeString('zh-CN', {hour12:false});
            entry.innerHTML = `<span class="timestamp">[${time}]</span>${msg}`;
            container.appendChild(entry);
            container.scrollTop = container.scrollHeight;
            document.getElementById('debug-log-count').textContent = container.children.length + ' 条';
            if (container.children.length > 300) container.removeChild(container.firstChild);
        }
        function clearLogs() {
            document.getElementById('logData').innerHTML = '';
            document.getElementById('logDebug').innerHTML = '';
            document.getElementById('data-log-count').textContent = '0 条';
            document.getElementById('debug-log-count').textContent = '0 条';
        }
        function clearData() {
            history = [];
            frameCount = 0;
            recordedCount = 0;
            errorCount = 0;
            frameCounter = 0;
            fps = 0;
            acquireStartTime = null;
            document.getElementById('fps').textContent = '0';
            document.getElementById('total-frames').textContent = '0';
            document.getElementById('recorded-frames').textContent = '0';
            document.getElementById('buf-size').textContent = '0';
            
            pressureCharts.forEach(c => c.lines.forEach(l => l.data = []));
            strainCharts.forEach(c => c.lines.forEach(l => l.data = []));
            wristChart.lines.forEach(l => l.data = []);
            backChart.lines.forEach(l => l.data = []);
            
            ['vals-pressure-thumb','vals-pressure-index','vals-pressure-middle'].forEach(id => {
                for(let i=0; i<9; i++) {
                    const el = document.getElementById(`${id}-v${i}`);
                    if(el) el.textContent = '--';
                }
            });
            ['vals-strain-thumb','vals-strain-index','vals-strain-middle'].forEach(id => {
                for(let i=0; i<2; i++) {
                    const el = document.getElementById(`${id}-v${i}`);
                    if(el) el.textContent = '--';
                }
            });
            ['vals-imu-wrist','vals-imu-back'].forEach(id => {
                for(let i=0; i<6; i++) {
                    const el = document.getElementById(`${id}-v${i}`);
                    if(el) el.textContent = '--';
                }
            });
            
            updateHandMap([0,0,0,0,0,0], [[0,0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0,0]], [0,0,0], [0,0,0], [0,0,0], [0,0,0]);
            if (document.getElementById('hand-map-modal').style.display === 'flex') {
                updateHandMap([0,0,0,0,0,0], [[0,0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0,0]], [0,0,0], [0,0,0], [0,0,0], [0,0,0], 'zoom');
            }
            
            addLogDebug('所有数据已清空，采集时长已重置');
        }
        function togglePause() {
            isPaused = !isPaused;
            document.getElementById('btn-pause').textContent = isPaused ? '继续' : '暂停';
            addLogDebug(isPaused ? '显示已暂停（后台仍接收）' : '显示已恢复');
        }
        async function exportCSV() {
            if (!history.length) { alert('暂无数据'); return; }
            let csv = 'time,timestamp,';
            for (let i = 0; i < 6; i++) csv += `strain${i+1},`;
            for (let a = 0; a < 3; a++) for (let p = 0; p < 9; p++) csv += `pressure${a}_${p},`;
            csv += 'wrist_ax,wrist_ay,wrist_az,wrist_gx,wrist_gy,wrist_gz,';
            csv += 'back_ax,back_ay,back_az,back_gx,back_gy,back_gz\n';
            
            history.forEach(f => {
                csv += `${f.time},`;
                csv += `${f.timestamp},`;
                csv += f.strain.map(v=>v.toFixed(6)).join(',') + ',';
                csv += f.pressure.flat().map(v=>v.toFixed(6)).join(',') + ',';
                csv += [...f.imu_wrist.accel, ...f.imu_wrist.gyro].map(v=>v.toFixed(4)).join(',') + ',';
                csv += [...f.imu_back.accel, ...f.imu_back.gyro].map(v=>v.toFixed(4)).join(',') + '\n';
            });
            
            const blob = new Blob(['\ufeff'+csv], {type:'text/csv;charset=utf-8;'});
            const filename = `glove_data_${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.csv`;

            // 优先使用文件系统保存对话框，让用户选择保存路径
            if (window.showSaveFilePicker) {
                try {
                    const handle = await window.showSaveFilePicker({
                        suggestedName: filename,
                        types: [{
                            description: 'CSV 文件',
                            accept: { 'text/csv': ['.csv'] }
                        }]
                    });
                    const writable = await handle.createWritable();
                    await writable.write(blob);
                    await writable.close();
                    addLogDebug(`已导出 ${history.length} 帧`);
                    return;
                } catch (e) {
                    if (e && e.name === 'AbortError') {
                        addLogDebug('已取消导出');
                        return;
                    }
                    addLogDebug('保存对话框不可用，已回退为浏览器下载');
                }
            }

            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            a.click();
            URL.revokeObjectURL(url);
            addLogDebug(`已导出 ${history.length} 帧`);
        }

        // ==================== 动画循环 ====================
        function animate() {
            const now = performance.now();
            if (now - lastFrameTime >= 1000) {
                fps = frameCounter;
                document.getElementById('fps').textContent = fps;
                frameCounter = 0;
                lastFrameTime = now;
            }
            pressureCharts.forEach(c => c.draw());
            strainCharts.forEach(c => c.draw());
            wristChart.draw();
            backChart.draw();
            if (zoomChart) zoomChart.draw();
            requestAnimationFrame(animate);
        }
        animate();

        // 启动页：校徽渐显 + 标题打字 + 点击按钮进入主界面
        function runSplashIntro() {
            const splash = document.getElementById('splash-screen');
            const enterBtn = document.getElementById('enter-app-btn');
            if (!splash) {
                document.body.classList.remove('splash-active');
                document.body.classList.add('app-ready');
                return;
            }
            const enterApp = () => {
                splash.classList.add('is-hidden');
                document.body.classList.remove('splash-active');
                document.body.classList.add('app-ready');
                window.setTimeout(() => splash.remove(), 520);
            };
            if (enterBtn) {
                enterBtn.addEventListener('click', enterApp, { once: true });
                window.setTimeout(() => enterBtn.focus(), 1500);
            }
        }
        window.addEventListener('load', runSplashIntro, { once: true });

        // 初始化
        applyTheme(localStorage.getItem('theme-preference') || 'dark');
        addLogDebug('系统就绪');
        addLogDebug('连接 ESP32 串口 (115200) 开始接收');
    
