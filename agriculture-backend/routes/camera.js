/**
 * ESP32-S3 摄像头代理
 * ------------------------------------------------------------------
 * 板子（OV2640）在局域网里跑了一个极简 HTTP 服务：
 *   GET /capture  一张 JPEG
 *   GET /stream   MJPEG 流
 *   GET /status   状态
 *
 * 这里把它代理到 /api/camera/*，好处：
 *   1. 浏览器和板子之间不用处理跨域
 *   2. 设备地址可以在后端统一配置（ESP32_CAM_URL），也可以由前端临时指定
 *
 * 用法：
 *   GET /api/camera/status?device=192.168.1.50
 *   GET /api/camera/snapshot?device=192.168.1.50
 *   GET /api/camera/stream?device=192.168.1.50
 *   device 省略时用 .env 里的 ESP32_CAM_URL
 */
const express = require('express')
const http = require('http')
const router = express.Router()

const DEFAULT_DEVICE = (process.env.ESP32_CAM_URL || '').trim()
const TIMEOUT_MS = Number(process.env.ESP32_CAM_TIMEOUT_MS || 8000)

// 复用连接：ESP32 建一次 TCP 要几十毫秒，每帧重连会明显拖慢
const agent = new http.Agent({ keepAlive: true, maxSockets: 4, keepAliveMsecs: 30000 })

function normalizeDevice(input) {
  let d = String(input || DEFAULT_DEVICE || '').trim()
  if (!d) return ''
  d = d.replace(/^https?:\/\//i, '').replace(/\/+$/, '')
  return d
}

// 只允许局域网 / 本机地址，避免这个接口被当成任意请求转发器
function isLocalHost(host) {
  if (!host) return false
  const h = host.split(':')[0]
  if (h === 'localhost') return true
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return false
  const a = Number(m[1]), b = Number(m[2])
  if (a === 10) return true
  if (a === 127) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  return false
}

function requestDevice(device, path, req, res, opts) {
  const options = opts || {}
  const host = device.split(':')[0]
  const port = Number(device.split(':')[1] || 80)
  return new Promise((resolve) => {
    const up = http.request({
      host,
      port,
      path,
      method: 'GET',
      agent,
      timeout: TIMEOUT_MS,
      headers: { 'User-Agent': 'agri-cam-proxy/1.0', Accept: options.accept || 'image/jpeg,*/*' }
    }, (upstream) => {
      resolve({ upstream, error: null })
    })
    up.on('timeout', () => { up.destroy(new Error('timeout')) })
    up.on('error', (e) => { resolve({ upstream: null, error: e }) })
    up.end()
  })
}

// 统一返回格式，跟项目其它接口一致
router.get('/status', async (req, res) => {
  const device = normalizeDevice(req.query.device)
  if (!device) return res.json({ code: 400, message: '未配置设备地址（ESP32_CAM_URL 或 ?device=）' })
  if (!isLocalHost(device)) return res.json({ code: 400, message: '只允许局域网地址' })

  const t0 = Date.now()
  const { upstream, error } = await requestDevice(device, '/status', req, res)
  if (error || !upstream) {
    return res.json({ code: 200, data: { ok: false, device, error: String((error && error.message) || 'unreachable') } })
  }
  let body = ''
  upstream.setEncoding('utf8')
  upstream.on('data', (c) => { body += c })
  upstream.on('end', () => {
    let ok = false
    try { ok = !!JSON.parse(body).ok } catch (e) { ok = upstream.statusCode === 200 }
    res.json({ code: 200, data: { ok, device, path: '/capture', latencyMs: Date.now() - t0 } })
  })
  upstream.on('error', () => {
    res.json({ code: 200, data: { ok: false, device, error: 'read error' } })
  })
})

router.get('/snapshot', async (req, res) => {
  const device = normalizeDevice(req.query.device)
  if (!device) return res.status(400).json({ code: 400, message: '未配置设备地址' })
  if (!isLocalHost(device)) return res.status(400).json({ code: 400, message: '只允许局域网地址' })

  const { upstream, error } = await requestDevice(device, '/capture', req, res)
  if (error || !upstream) {
    return res.status(502).json({ code: 502, message: '连不上设备：' + String((error && error.message) || '') })
  }
  if (upstream.statusCode !== 200) {
    upstream.resume()
    return res.status(502).json({ code: 502, message: '设备返回 ' + upstream.statusCode })
  }
  res.writeHead(200, {
    'Content-Type': upstream.headers['content-type'] || 'image/jpeg',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  })
  upstream.pipe(res)
  upstream.on('error', () => { try { res.end() } catch (e) {} })
})

// MJPEG 直通（长连接，不设超时）
router.get('/stream', async (req, res) => {
  const device = normalizeDevice(req.query.device)
  if (!device || !isLocalHost(device)) return res.status(400).json({ code: 400, message: '设备地址无效' })

  const host = device.split(':')[0]
  const port = Number(device.split(':')[1] || 80)
  const up = http.request({ host, port, path: '/stream', method: 'GET', agent: false, headers: { Accept: 'multipart/x-mixed-replace,*/*' } }, (upstream) => {
    if (upstream.statusCode !== 200) {
      upstream.resume()
      return res.status(502).json({ code: 502, message: '设备不支持流' })
    }
    res.writeHead(200, {
      'Content-Type': upstream.headers['content-type'] || 'multipart/x-mixed-replace;boundary=frame',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*'
    })
    upstream.pipe(res)
  })
  up.on('error', () => { try { res.status(502).end() } catch (e) {} })
  up.end()
  req.on('close', () => { try { up.destroy() } catch (e) {} })
})

module.exports = router
