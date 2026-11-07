/**
 * ESP32-S3 摄像头兼容层（禾诊 · 实时监测）
 * ------------------------------------------------------------------
 * 把板子（OV2640）的画面伪装成 navigator.mediaDevices.getUserMedia() 返回的
 * 摄像头流，页面里原有的取景/识别逻辑一行都不用改。
 *
 * 稳定性设计：
 *   1. 设备地址由后端下发（/api/camera/config），换 IP 不用改前端
 *   2. 连接失败会依次尝试：后端下发 → 上次保存 → 内置默认
 *   3. 连续取帧失败 5 次自动重连，不会卡死在"连不上"
 */
(function () {
  'use strict'

  var LS_KEY = 'esp32camDevice'
  var DEFAULT_DEVICE = '192.168.10.150'
  var STATE = { device: '', ok: false, frames: 0, fps: 0, mode: 'direct', fails: 0 }

  function qs(name) {
    try { return new URLSearchParams(location.search).get(name) || '' } catch (e) { return '' }
  }
  function readSaved() {
    try { return localStorage.getItem(LS_KEY) || '' } catch (e) { return '' }
  }
  function saveDevice(v) {
    try { localStorage.setItem(LS_KEY, v) } catch (e) {}
  }

  // ---------------- 后端接口地址（项目约定：H5 用"当前主机 + 3000 端口"） ----------------
  var _apiBase = ''
  function apiCandidates() {
    var host = location.hostname || 'localhost'
    var proto = location.protocol === 'https:' ? 'https:' : 'http:'
    return [proto + '//' + host + ':3000/api/camera', location.origin + '/api/camera']
  }
  function resolveApiBase() {
    if (_apiBase) return Promise.resolve(_apiBase)
    var list = apiCandidates(), i = 0
    function next() {
      if (i >= list.length) return Promise.resolve('')
      var base = list[i++]
      return fetch(base + '/config', { cache: 'no-store' })
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
      'box-shadow:0 6px 20px rgba(0,0,0,.35)', 'max-width:300px'
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
          '<button id="esp-auto" style="background:transparent;border:1px solid rgba(56,193,114,.4);color:#9fe8c4;border-radius:6px;padding:4px 8px;font-size:12px;cursor:pointer">自动</button>' +
        '</div>' +
        '<div id="esp-msg" style="margin-top:5px;opacity:.75;font-size:11px;line-height:1.4">未连接</div>' +
      '</div>'
    document.body.appendChild(panel)
    var input = panel.querySelector('#esp-ip')
    input.value = STATE.device || ''
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') connect(input.value) })
    panel.querySelector('#esp-go').addEventListener('click', function () { connect(input.value) })
    panel.querySelector('#esp-auto').addEventListener('click', function () { autoConnect(true) })
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
  function drawPlaceholder(msg) {
    if (!ctx) return
    ctx.fillStyle = '#0b1220'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = '#9fe8c4'
    ctx.font = '22px system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText(msg, canvas.width / 2, canvas.height / 2 + 8)
  }

  function ensureCanvas() {
    if (canvas) return canvas
    canvas = document.createElement('canvas')
    canvas.width = 640
    canvas.height = 480
    ctx = canvas.getContext('2d')
    ctx.fillStyle = '#0b1220'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    drawPlaceholder('正在连接摄像头…')
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
    var hud = stage.querySelectorAll('.hud, .hud-top, .hud-bottom')
    for (var i = 0; i < hud.length; i++) hud[i].style.zIndex = '3'
    return overlay
  }

  // ---------------- 取帧 ----------------
  var polling = false, pollToken = 0
  function stopPolling() { pollToken++; polling = false }

  function drawFrame(bmp, device) {
    if (canvas.width !== bmp.width) { canvas.width = bmp.width; canvas.height = bmp.height }
    ctx.drawImage(bmp, 0, 0)
    var view = ensureOverlay()
    if (view) {
      if (view.width !== bmp.width) { view.width = bmp.width; view.height = bmp.height }
      view.getContext('2d').drawImage(bmp, 0, 0)
    }
    STATE.frames++
  }

  function startPolling(base, device) {
    stopPolling()
    polling = true
    var token = pollToken
    ensureCanvas()
    STATE.fails = 0
    var last = performance.now(), count = 0
    var url = base + '/capture?t='

    function tick() {
      if (token !== pollToken) return
      fetch(url + Date.now(), { cache: 'no-store', mode: 'cors' })
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status)
          return r.blob()
        })
        .then(function (b) { return createImageBitmap(b) })
        .then(function (bmp) {
          STATE.fails = 0
          drawFrame(bmp, device)
          if (bmp.close) bmp.close()
          count++
          var now = performance.now()
          if (now - last >= 1000) {
            STATE.fps = Math.round(count * 1000 / (now - last))
            count = 0; last = now
            setStatus(true, '已连接 ' + device + ' · ' + canvas.width + 'x' + canvas.height +
                      ' · ' + STATE.fps + ' fps · ' + (STATE.mode === 'direct' ? '直连' : '代理'))
          }
        })
        .catch(function (e) {
          STATE.fails++
          if (STATE.mode === 'direct' && _apiBase && STATE.fails === 1) {
            STATE.mode = 'proxy'
            url = _apiBase + '/snapshot?t='
            setStatus(false, '直连失败，切换代理…')
          } else {
            setStatus(false, '取帧失败 ' + STATE.fails + ' 次：' + ((e && e.message) || e))
          }
          if (STATE.fails >= 5) {
            // 连续失败：自动重新解析设备地址并重连
            setStatus(false, '连接中断，正在自动重连…')
            setTimeout(function () { autoConnect(false) }, 2000)
            return
          }
        })
        .finally(function () {
          if (token === pollToken) setTimeout(tick, 0)
        })
    }
    tick()
  }

  // ---------------- 连接 ----------------
  var _backendDevice = ''
  function fetchBackendDevice() {
    return resolveApiBase().then(function (base) {
      if (!base) return ''
      return fetch(base + '/config', { cache: 'no-store' })
        .then(function (r) { return r.json() })
        .then(function (j) {
          _backendDevice = (j && j.data && j.data.device) || ''
          return _backendDevice
        })
        .catch(function () { return '' })
    })
  }

  function candidates() {
    var list = []
    function push(d) {
      d = String(d || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '')
      if (d && list.indexOf(d) < 0) list.push(d)
    }
    push(qs('esp32'))
    push(_backendDevice)
    push(readSaved())
    push(DEFAULT_DEVICE)
    return list
  }

  function probe(device) {
    return fetch('http://' + device + '/status', { cache: 'no-store', mode: 'cors' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json() })
      .then(function (j) { return !!(j && j.ok) })
      .catch(function () {
        // 直连不通（跨域/网络），用后端代理探一次
        if (!_apiBase) return false
        return fetch(_apiBase + '/status?device=' + encodeURIComponent(device), { cache: 'no-store' })
          .then(function (r) { return r.json() })
          .then(function (j) { return !!(j && j.data && j.data.ok) })
          .catch(function () { return false })
      })
  }

  // 让后端扫一遍局域网，找出摄像头（应对 DHCP 换 IP）
  function discoverDevices() {
    return resolveApiBase().then(function (base) {
      if (!base) return []
      setStatus(false, '正在局域网内搜索摄像头…')
      return fetch(base + '/discover', { cache: 'no-store' })
        .then(function (r) { return r.json() })
        .then(function (j) { return (j && j.data && j.data.found) || [] })
        .catch(function () { return [] })
    })
  }

  function tryList(list, i) {
    if (i >= list.length) {
      discoverDevices().then(function (found) {
        if (found.length > 0) {
          tryList(found, 0)
        } else {
          setStatus(false, '没找到摄像头：确认板子已上电、和电脑连同一个 Wi-Fi')
        }
      })
      return
    }
    var d = list[i]
    setStatus(false, '正在尝试 ' + d + ' …')
    probe(d).then(function (ok) {
      if (!ok) return tryList(list, i + 1)
      STATE.device = d
      saveDevice(d)
      STATE.mode = 'direct'
      setStatus(false, '已连接 ' + d + '，开始取画面…')
      startPolling('http://' + d, d)
    })
  }

  var lastAutoAt = 0, autoRunning = false
  function autoConnect(force) {
    var now = Date.now()
    if (!force && (autoRunning || now - lastAutoAt < 8000)) return   // 节流，避免反复扫全网段
    lastAutoAt = now
    autoRunning = true
    if (force) setStatus(false, '正在自动查找设备…')
    fetchBackendDevice().then(function () {
      tryList(candidates(), 0)
    }).finally(function () {
      // 给探测本身留点时间再释放锁
      setTimeout(function () { autoRunning = false }, 3000)
    })
  }

  // 手动指定设备
  function connect(device) {
    var d = String(device || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '')
    if (!d) { setStatus(false, '请先填写设备 IP'); return }
    STATE.device = d
    saveDevice(d)
    setStatus(false, '正在连接 ' + d + ' …')
    probe(d).then(function (ok) {
      if (!ok) { setStatus(false, '连不上 ' + d + '（确认板子已上电并与电脑同一 Wi-Fi）'); return }
      STATE.mode = 'direct'
      setStatus(false, '已连接 ' + d + '，开始取画面…')
      startPolling('http://' + d, d)
    })
  }

  // ---------------- 伪装摄像头 ----------------
  var forcePcCamera = (qs('camera') === 'pc')

  function install() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return
    var original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
    navigator.mediaDevices.getUserMedia = function (constraints) {
      var wantsVideo = !constraints || constraints.video
      // 注意：不能因为"还没拿到设备地址"就放行给电脑摄像头。
      // 页面一旦拿到电脑摄像头的流，之后就连不上板子了（要刷新才行）。
      if (!wantsVideo || forcePcCamera) return original(constraints)
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

  // 单页应用里"进入实时监测页"不会触发页面重载，所以要在路由变化时主动接上
  var inCamPage = false
  function syncRoute() {
    if (qs('camera') === 'pc') return
    var cam = isCamPage()
    if (cam && !inCamPage) {
      inCamPage = true
      if (!panel) buildPanel()
      if (STATE.ok && polling) return          // 已经在取流，不用重连
      if (!STATE.device) STATE.device = qs('esp32') || readSaved()
      autoConnect(false)
    } else if (!cam && inCamPage) {
      inCamPage = false
      stopPolling()                            // 离开页面就停止取帧，省带宽
    }
  }

  STATE.device = qs('esp32') || readSaved()
  ensureCanvas()
  install()

  function startRouteWatch() {
    syncRoute()
    window.addEventListener('hashchange', syncRoute)
    window.addEventListener('popstate', syncRoute)
    // uni-app H5 内部路由不一定会抛 hashchange，兜底轮询
    setInterval(syncRoute, 1200)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startRouteWatch)
  } else {
    startRouteWatch()
  }

  window.__esp32cam = {
    connect: connect,
    auto: autoConnect,
    state: STATE,
    useDesktopCamera: function () { STATE.device = ''; saveDevice(''); location.reload() }
  }
})()
