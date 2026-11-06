#!/usr/bin/env node
/**
 * AI 密钥自检
 * ------------------------------------------------------------
 * 用法： node scripts/check-ai-keys.js
 *
 * 会真实请求一次 DeepSeek 和百度，直接告诉你密钥能不能用、
 * 以及不能用时到底缺什么，不用去猜。
 */
const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '..', '.env') })

const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || ''
const BAIDU_AK = process.env.BAIDU_API_KEY || ''
const BAIDU_SK = process.env.BAIDU_SECRET_KEY || ''

function line() { console.log('-'.repeat(56)) }

async function testDeepSeek() {
  line()
  console.log('DeepSeek')
  if (!DEEPSEEK_KEY) return console.log('  ✗ 未配置 DEEPSEEK_API_KEY')
  console.log('  key: ' + DEEPSEEK_KEY.slice(0, 6) + '...' + DEEPSEEK_KEY.slice(-4) + '（' + DEEPSEEK_KEY.length + ' 字符）')
  if (!DEEPSEEK_KEY.startsWith('sk-')) {
    console.log('  ⚠ 提醒：DeepSeek 的 key 以 sk- 开头，你这个不像（更像 UUID）')
  }
  try {
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + DEEPSEEK_KEY },
      body: JSON.stringify({ model: process.env.DEEPSEEK_MODEL || 'deepseek-chat', messages: [{ role: 'user', content: 'ping' }], max_tokens: 5 })
    })
    const text = await res.text()
    let json = {}
    try { json = JSON.parse(text) } catch (e) {}
    if (res.status === 200 && json.choices) {
      console.log('  ✓ 可用')
    } else {
      console.log('  ✗ HTTP ' + res.status + ' — ' + ((json.error && json.error.message) || text.slice(0, 120)))
    }
  } catch (e) {
    console.log('  ✗ 网络错误：' + e.message)
  }
}

async function testBaidu() {
  line()
  console.log('百度 AI（植物识别）')
  if (!BAIDU_AK) return console.log('  ✗ 未配置 BAIDU_API_KEY')
  console.log('  API Key: ' + BAIDU_AK.slice(0, 6) + '...（' + BAIDU_AK.length + ' 字符）')
  if (!BAIDU_SK) {
    console.log('  ✗ 未配置 BAIDU_SECRET_KEY —— 百度要求 API Key + Secret Key 两个都要')
    return
  }
  console.log('  Secret Key: ' + BAIDU_SK.slice(0, 4) + '...（' + BAIDU_SK.length + ' 字符）')
  try {
    const url = 'https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials'
      + '&client_id=' + encodeURIComponent(BAIDU_AK) + '&client_secret=' + encodeURIComponent(BAIDU_SK)
    const res = await fetch(url, { method: 'POST' })
    const json = await res.json()
    if (json.access_token) {
      console.log('  ✓ 可用（access_token 已获取）')
    } else {
      console.log('  ✗ ' + (json.error_description || json.error || JSON.stringify(json)))
    }
  } catch (e) {
    console.log('  ✗ 网络错误：' + e.message)
  }
}

;(async () => {
  await testDeepSeek()
  await testBaidu()
  line()
})()
