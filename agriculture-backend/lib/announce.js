/**
 * 识别结果语音播报
 * ------------------------------------------------------------------
 * 流程：识别结果 → 合成语音（SAPI） → POST 原始 PCM 到 ESP32 的 /speak
 * 特性：同一病害 60 秒内不重复播报；正在播报时新结果直接跳过，避免堆积
 */
const http = require('http')
const { synthesize } = require('./tts')

const DEVICE = (process.env.ESP32_CAM_URL || '').trim()
const COOLDOWN_MS = Number(process.env.ANNOUNCE_COOLDOWN_MS || 60000)
const ENABLED = String(process.env.ANNOUNCE || '1') !== '0'

let busy = false
let lastText = ''
let lastAt = 0

function postPcm(device, pcm) {
  return new Promise((resolve, reject) => {
    const host = device.replace(/^https?:\/\//i, '').split(':')[0]
    const port = Number(device.replace(/^https?:\/\//i, '').split(':')[1] || 80)
    const req = http.request({
      host,
      port,
      path: '/speak',
      method: 'POST',
      timeout: 30000,
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': pcm.length }
    }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { body += c })
      res.on('end', () => resolve({ status: res.statusCode, body }))
    })
    req.on('timeout', () => req.destroy(new Error('播放超时')))
    req.on('error', reject)
    req.end(pcm)
  })
}

// 语音文本清洗：去掉会念错的成分
//   · 括号里的拉丁学名（"月季白粉病（Podosphaera pannosa）" → "月季白粉病"）
//   · 连续英文、特殊符号
//   · "15%" → "百分之十五"，避免念成"15百分之"
function cleanForTTS(s) {
  return String(s || '')
    .replace(/[（(][^）)]*[）)]/g, '')                  // 括号内容（学名、别名）整段去掉
    .replace(/[A-Za-z]+/g, ' ')                        // 残留英文
    .replace(/(\d+(?:\.\d+)?)\s*%/g, '百分之$1')   // 15% → 百分之15
    .replace(/[~～—]/g, '到')
    .replace(/[·•＊*#@_=+/\\|<>\[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// 把识别结果拼成一句口语化的话：
//   病名 + 危害等级，就够了。防治建议里有大量剂量数字，念出来又长又容易错，
//   交给界面展示即可。
function buildSentence(d) {
  const rawName = d.name || d.diseaseName || ''
  if (!rawName || /未识别到植物/.test(rawName)) return ''

  const name = cleanForTTS(rawName).slice(0, 18)
  if (!name) return ''

  const lvText = cleanForTTS(d.levelText || '')
  const lv = lvText ? '，' + lvText : ''

  let extra = ''
  if (Array.isArray(d.suggestions) && d.suggestions.length) {
    const first = cleanForTTS(d.suggestions[0])
    // 短且不含数字的建议才念，避免"1500倍液"被截断
    if (first && first.length <= 16 && !/[\d]/.test(first)) extra = '。建议' + first
  }
  return ('检测到' + name + lv + extra).slice(0, 48)
}

async function announceResult(d, device) {
  if (!ENABLED) return { skipped: 'disabled' }
  const dev = device || DEVICE
  if (!dev) return { skipped: 'no-device' }

  const text = buildSentence(d)
  if (!text) return { skipped: 'no-text' }

  const now = Date.now()
  if (text === lastText && now - lastAt < COOLDOWN_MS) return { skipped: 'cooldown' }
  if (busy) return { skipped: 'busy' }

  busy = true
  lastText = text
  lastAt = now
  try {
    const { pcm } = await synthesize(text)
    const r = await postPcm(dev, pcm)
    console.log('🔊 播报：' + text + '（' + (pcm.length / 2 / 24000).toFixed(1) + ' 秒）')
    return { ok: true, text, bytes: pcm.length, status: r.status }
  } catch (e) {
    console.error('播报失败：' + e.message)
    return { error: e.message }
  } finally {
    busy = false
  }
}

module.exports = { announceResult, buildSentence, cleanForTTS }
