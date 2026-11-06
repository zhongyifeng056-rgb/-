/**
 * ESP32-S3 摄像头兼容层（禾诊 · 实时监测）
 * ------------------------------------------------------------------
 * 把板子（OV2640）的画面伪装成 navigator.mediaDevices.getUserMedia() 返回的
 * 摄像头流，页面里原有的取景/识别逻辑一行都不用改。
 *
 * 数据通路（延迟最优）：
 *   浏览器  --直连-->  ESP32-S3 http://<设备IP>/capture
 * 直连不通时自动退回后端代理 /api/camera/snapshot。
 *
 * 两条线并行：
 *   1. 一张离屏 canvas 持续更新 —— 作为"摄像头流"喂给页面，识别从它取帧
 *   2. 一张可见 canvas 贴在取景框上 —— 保证你能直接看到画面
 */
(function () {
  'use strict'

  var LS_KEY = 'esp32camDevice'
  var DEFAULT_DEVICE = '10.44.130.135'
  var STATE = { device: '', ok: false, frames: 0, fps: 0, mode: 'direct', lastError: '' }

  function qs(name) {
    try { return new URLSearchParams(location.search).get(name) || '' } catch (e) { return '' }
  }
  function readSaved() {
    try { return localStorage.getItem(LS_KEY) || DEFAULT_DEVICE } catch (e) { return DEFAULT_DEVICE }
  }
  function saveDevice(v) {
    try { localStorage.setItem(LS_KEY, v) } catch (e) {}
  }

  // ---------------- 后端地址（项目约定：H5 用"当前主机 + 3000 端口"） ----------------
  var _apiBase = ''
  function apiCandidates() {
    var host = location.hostname || 'localhost'
    var proto = location.protocol === 'https:' ? 'https:' : 'http:'
    return [proto + '//' + host + ':3000/api/camera', location.origin + '/api/camera']
  }
  function resolveApiBase() {
    var list = apiCandidates(), i = 0
    function next() {
      if (i >= list.length) return Promise.resolve('')
      var base = list[i++]
      return fetch(base + '/status', { cache: 'no-store' })
        .then(function (r) { return r.json() })
        .then(function (j) {
          if (j && j.data !== undefined) { _apiBase = base; return base }
          return next()
        })
        .catch(function () { return next() })
    }
    return next()
  }

  // ---------------- 面板 ----------------
  var panel = null
  function buildPanel() {
    if (panel) return panel
    panel = document.createElement('div')
    panel.id = 'esp32cam-panel'
    panel.style.cssText = [
      'position:fixed', 'right:12px', 'top:12px', 'z-index:2147483647',
      'background:rgba(12,26,22,.92)', 'color:#e8fff4', 'border:1px solid rgba(56,193,114,.5)',
      'border-radius:10px', 'padding:8px 10px', 'font:12px/1.5 system-ui,-apple-system,sans-serif',
      'box-shadow:0 6px 20px rgba(0,0,0,.35)', 'max-width:290px'
    ].join(';')
    panel.innerHTML =
      '<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">' +
        '<span id="esp-dot" style="width:8px;height:8px;border-radius:50%;background:#888;display:inline-block"></span>' +
        '<b style="font-size:12px">ESP32 摄像头</b>' +
        '<span id="esp-min" style="margin-left:auto;cursor:pointer;opacity:.6">—</span>' +
      '</div>' +
      '<div id="esp-body">' +
        '<div style="display:flex;gap:6px">' +
          '<input id="esp-ip" placeholder="192.168.1.50" style="flex:1;min-width:0;background:#0a1714;border:1px solid rgba(56,193,114,.4);color:#e8fff4;border-radius:6px;padding:4px 6px;font-size:12px" />' +
          '<button id="esp-go" style="background:#38c172;border:0;color:#04140c;border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer">连接</button>' +
        '</div>' +
        '<div id="esp-msg" style="margin-top:5px;opacity:.75;font-size:11px;line-height:1.4">未连接</div>' +
      '</div>'
    document.body.appendChild(panel)
    var input = panel.querySelector('#esp-ip')
    input.value = STATE.device || ''
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') connect(input.value) })
    panel.querySelector('#esp-go').addEventListener('click', function () { connect(input.value) })
    panel.querySelector('#esp-min').addEventListener('click', function () {
      var b = panel.querySelector('#esp-body')
      b.style.display = b.style.display === 'none' ? 'block' : 'none'
    })
    return panel
  }

  function setStatus(ok, text) {
    STATE.ok = ok
    if (!panel) return
    var dot = panel.querySelector('#esp-dot')
    var msg = panel.querySelector('#esp-msg')
    if (dot) dot.style.background = ok ? '#38c172' : '#e05252'
    if (msg) msg.textContent = text
  }

  // ---------------- 画布 ----------------
  var canvas = null, ctx = null, overlay = null

  function ensureCanvas() {
    if (canvas) return canvas
    canvas = document.createElement('canvas')
    canvas.width = 640
    canvas.height = 480
    ctx = canvas.getContext('2d')
    ctx.fillStyle = '#0b1220'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    return canvas
  }

  function ensureOverlay() {
    if (overlay && document.body.contains(overlay)) return overlay
    var stage = document.querySelector('.stage')
    if (!stage) return null
    overlay = document.createElement('canvas')
    overlay.id = 'esp32cam-view'
    overlay.width = 640
    overlay.height = 480
    overlay.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;object-fit:cover;z-index:1;pointer-events:none;background:#000'
    stage.appendChild(overlay)
    // 保证我们这层在页面 video 之上、在结果卡片/HUD 之下
    var hud = stage.querySelectorAll('.hud, .hud-top, .hud-bottom')
    for (var i = 0; i < hud.length; i++) hud[i].style.zIndex = '3'
    return overlay
  }

  // ---------------- 取帧 ----------------
  var polling = false
  function startPolling(base, device) {
    if (polling) return
    polling = true
    ensureCanvas()
    var last = performance.now(), count = 0, url = base + '/capture?t='

    function tick() {
      fetch(url + Date.now(), { cache: 'no-store', mode: 'cors' })
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status)
          return r.blob()
        })
        .then(function (b) { return createImageBitmap(b) })
        .then(function (bmp) {
          if (canvas.width !== bmp.width) { canvas.width = bmp.width; canvas.height = bmp.height }
          ctx.drawImage(bmp, 0, 0)
          var view = ensureOverlay()
          if (view) {
            if (view.width !== bmp.width) { view.width = bmp.width; view.height = bmp.height }
            view.getContext('2d').drawImage(bmp, 0, 0)
          }
          if (bmp.close) bmp.close()
          STATE.frames++; count++
          var now = performance.now()
          if (now - last >= 1000) {
            STATE.fps = Math.round(count * 1000 / (now - last))
            count = 0; last = now
            setStatus(true, '已连接 ' + device + ' · ' + canvas.width + 'x' + canvas.height +
                      ' · ' + STATE.fps + ' fps · ' + (STATE.mode === 'direct' ? '直连' : '代理'))
          }
        })
        .catch(function (e) {
          STATE.lastError = String((e && e.message) || e)
          setStatus(false, '取帧失败：' + STATE.lastError)
          if (STATE.mode === 'direct' && _apiBase) { STATE.mode = 'proxy'; url = _apiBase + '/snapshot?t=' }
        })
        .finally(function () { setTimeout(tick, 0) })
    }
    tick()
  }

  // ---------------- 连接 ----------------
  function connect(device) {
    var d = String(device || '').trim()
    if (!d) { setStatus(false, '请先填写设备 IP'); return }
    d = d.replace(/^https?:\/\//i, '').replace(/\/+$/, '')
    STATE.device = d
    saveDevice(d)
    setStatus(false, '正在连接 ' + d + ' …')
    STATE.mode = 'direct'

    fetch('http://' + d + '/status', { cache: 'no-store', mode: 'cors' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json() })
      .then(function (j) {
        if (!j || !j.ok) throw new Error('设备未就绪')
        STATE.mode = 'direct'
        setStatus(false, '已直连 ' + d + '，开始取画面…')
        startPolling('http://' + d, d)
      })
      .catch(function () {
        STATE.mode = 'proxy'
        setStatus(false, '直连不通，改走后端代理…')
        resolveApiBase().then(function (base) {
          if (!base) { setStatus(false, '后端接口不可达（3000 端口没起来？）'); return }
          fetch(base + '/status?device=' + encodeURIComponent(d), { cache: 'no-store' })
            .then(function (r) { return r.json() })
            .then(function (j) {
              var data = (j && j.data) || {}
              if (!data.ok) { setStatus(false, '连不上 ' + d + '：' + (data.error || '无响应')); return }
              setStatus(false, '经代理连通 ' + d + '，开始取画面…')
              startPolling(base, d)
            })
        })
      })
  }

  // ---------------- 伪装摄像头 ----------------
  function install() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return
    var original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
    navigator.mediaDevices.getUserMedia = function (constraints) {
      var wantsVideo = !constraints || constraints.video
      if (!wantsVideo || !STATE.device) return original(constraints)
      ensureCanvas()
      try {
        return Promise.resolve(canvas.captureStream(15))
      } catch (e) {
        return original(constraints)
      }
    }
  }

  function isCamPage() {
    return /realtime|recognize/.test(location.pathname + location.hash)
  }

  function boot() {
    if (!isCamPage()) return
    if (qs('camera') === 'pc') { STATE.device = ''; return }
    buildPanel()
    if (!STATE.device) { setStatus(false, '未连接，填入设备局域网 IP'); return }
    connect(STATE.device)
  }

  STATE.device = qs('esp32') || readSaved()
  ensureCanvas()
  install()

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot)
  } else {
    boot()
  }

  window.__esp32cam = {
    connect: connect,
    state: STATE,
    useDesktopCamera: function () { STATE.device = ''; saveDevice(''); location.reload() }
  }
})()
