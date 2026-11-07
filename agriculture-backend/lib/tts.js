/**
 * 文字转语音
 * ------------------------------------------------------------------
 * 首选：edge-tts 神经网络音色（zh-CN-XiaoxiaoNeural，接近小智的听感）
 *       —— 需要联网，首次调用稍慢，结果按文本缓存
 * 兜底：Windows 自带 SAPI（Huihui），离线可用，音质一般
 *
 * 输出统一为：原始 PCM，16 位单声道 24kHz（ESP32-S3 解码器的格式）
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { execFile } = require('child_process')

const SAMPLE_RATE = 24000
const SCRIPTS = path.join(__dirname, '..', 'scripts')
const PS_SCRIPT = path.join(SCRIPTS, 'tts.ps1')
const PY_SCRIPT = path.join(SCRIPTS, 'tts_online.py')
const TMP = path.join(os.tmpdir(), 'hezhen-tts')
if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true })

const ONLINE = String(process.env.TTS_ONLINE || '1') !== '0'
const cache = new Map()
const MAX_CACHE = 40

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 60000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message || '').slice(0, 300)))
      resolve()
    })
  })
}

// 从 WAV 里取出 PCM（SAPI 兜底路径用）
function extractPcm(wav) {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF') return null
  let offset = 12
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4)
    const size = wav.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'data') {
      const end = Math.min(body + size, wav.length)
      return wav.subarray(body, end)
    }
    offset = body + size + (size % 2)
  }
  return null
}

function resampleTo24k(pcm, rate) {
  if (rate === SAMPLE_RATE) return pcm
  const ratio = SAMPLE_RATE / rate
  const inSamples = Math.floor(pcm.length / 2)
  const outSamples = Math.floor(inSamples * ratio)
  const out = Buffer.alloc(outSamples * 2)
  for (let i = 0; i < outSamples; i++) {
    const pos = i / ratio
    const i0 = Math.floor(pos)
    const i1 = Math.min(i0 + 1, inSamples - 1)
    const frac = pos - i0
    const s0 = pcm.readInt16LE(i0 * 2)
    const s1 = pcm.readInt16LE(i1 * 2)
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s0 + (s1 - s0) * frac))), i * 2)
  }
  return out
}

async function synthWithSapi(text, id) {
  const textFile = path.join(TMP, id + '.txt')
  const wavFile = path.join(TMP, id + '.sapi.wav')
  fs.writeFileSync(textFile, text, 'utf8')
  if (!fs.existsSync(wavFile)) {
    await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS_SCRIPT, '-TextFile', textFile, '-OutFile', wavFile])
  }
  const wav = fs.readFileSync(wavFile)
  const pcm = extractPcm(wav)
  if (!pcm) throw new Error('WAV 解析失败')
  return Buffer.from(pcm)
}

async function synthWithEdge(text, id) {
  const textFile = path.join(TMP, id + '.txt')
  const pcmFile = path.join(TMP, id + '.edge.pcm')
  fs.writeFileSync(textFile, text, 'utf8')
  if (!fs.existsSync(pcmFile) || fs.statSync(pcmFile).size === 0) {
    try { fs.unlinkSync(pcmFile) } catch (e) {}
    await run('python', [PY_SCRIPT, textFile, pcmFile])
  }
  return fs.readFileSync(pcmFile)
}

/**
 * 合成一句中文，返回 { pcm, sampleRate, engine }
 */
async function synthesize(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim()
  if (!clean) throw new Error('文本为空')
  if (cache.has(clean)) return cache.get(clean)

  const id = crypto.createHash('md5').update(clean).digest('hex').slice(0, 12)
  let pcm = null
  let engine = 'edge'

  if (ONLINE) {
    try {
      pcm = await synthWithEdge(clean, id)
    } catch (e) {
      console.warn('神经网络语音失败，改用系统语音：' + e.message)
      pcm = null
    }
  }

  if (!pcm || pcm.length === 0) {
    engine = 'sapi'
    pcm = await synthWithSapi(clean, id)
    pcm = resampleTo24k(pcm, SAMPLE_RATE)   // SAPI 已按 24k 输出，这里兜底
  }

  const result = { pcm, sampleRate: SAMPLE_RATE, engine }
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value)
  cache.set(clean, result)
  return result
}

module.exports = { synthesize, SAMPLE_RATE }
