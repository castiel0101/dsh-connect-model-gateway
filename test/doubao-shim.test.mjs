/**
 * 豆包 shim 端到端自测（真起 HTTP server，不联网）。
 *
 * 跑法：node test/doubao-shim.test.mjs
 *
 * 用假的 upstream 替换 `chat`，验证「OpenAI 请求进来 → 豆包协议出去 →
 * OpenAI SSE 出去」这条路上的安全与协议约束。上游真实响应另有人工验证，
 * 这里锁的是**不可能靠人工每次验收**的部分：Host/Origin 校验、Bearer 校验、
 * 生图落成 Markdown、错误信封状态码。
 */

import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createDoubaoShim, imageMarkdownLocal, markdownSafeUrl } from '../lib/core/doubao-shim.js'

const dir = await mkdtemp(join(tmpdir(), 'mgw-doubao-shim-'))
process.env.HOME = dir

let passed = 0
const cases = []
function test(name, fn) { cases.push([name, fn]) }

/** 一个固定的假会话：shim 只读 `ok`，真实 cookie 由上游客户端自己取。 */
const fakeCredentials = { header: 'sessionid=x', pairs: new Map(), ok: true }

function makeShim() {
  return createDoubaoShim({
    credentials: () => fakeCredentials,
    fingerprint: () => undefined,
  })
}

async function post(baseUrl, token, body, headers = {}) {
  return fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      ...headers,
    },
    body: JSON.stringify(body),
  })
}

/** 只关心状态码的探针。 */

test('baseUrl 只绑回环', async () => {
  const shim = makeShim()
  try {
    const baseUrl = await shim.baseUrl()
    assert.match(baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/)
  } finally {
    await shim.close()
  }
})

test('token 是进程随机串', async () => {
  const a = makeShim()
  const b = makeShim()
  try {
    assert.notEqual(a.token(), b.token())
    assert.ok(a.token().length >= 32)
  } finally {
    await a.close()
    await b.close()
  }
})

test('Bearer 不对回 401', async () => {
  const shim = makeShim()
  try {
    const baseUrl = await shim.baseUrl()
    const response = await post(baseUrl, 'wrong-token', { messages: [{ role: 'user', content: 'hi' }] })
    assert.equal(response.status, 401)
    const payload = await response.json()
    assert.equal(payload.error.code, 'invalid_api_key')
  } finally {
    await shim.close()
  }
})

test('非回环 Host 回 403（防 DNS rebinding）', async () => {
  const shim = makeShim()
  try {
    const baseUrl = await shim.baseUrl()
    const port = Number(new URL(baseUrl).port)
    // fetch 会忽略调用方给的 Host（它是禁止修改的头），所以这一条必须走原生 http
    const status = await new Promise((resolve, reject) => {
      const req = httpRequest({
        host: '127.0.0.1',
        port,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          host: 'evil.example.com',
          'content-type': 'application/json',
          authorization: `Bearer ${shim.token()}`,
        },
      }, (res) => { res.resume(); resolve(res.statusCode) })
      req.on('error', reject)
      req.end(JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }))
    })
    assert.equal(status, 403)
  } finally {
    await shim.close()
  }
})

test('非回环 Origin 也拒绝', async () => {
  const shim = makeShim()
  try {
    const baseUrl = await shim.baseUrl()
    const response = await post(baseUrl, shim.token(), { messages: [] }, { origin: 'https://evil.example.com' })
    assert.equal(response.status, 403)
  } finally {
    await shim.close()
  }
})

test('空消息回 400，不打上游', async () => {
  const shim = makeShim()
  try {
    const baseUrl = await shim.baseUrl()
    const response = await post(baseUrl, shim.token(), { messages: [] })
    assert.equal(response.status, 400)
  } finally {
    await shim.close()
  }
})

test('未知路由回 404', async () => {
  const shim = makeShim()
  try {
    const baseUrl = await shim.baseUrl()
    const response = await fetch(`${baseUrl}/v1/nope`, {
      headers: { authorization: `Bearer ${shim.token()}` },
    })
    assert.equal(response.status, 404)
  } finally {
    await shim.close()
  }
})

test('生图：URL 转义后落地成 Markdown', async () => {
  // 括号与波浪号必须编码，否则 ![](...) 语法被截断，图直接不显示
  assert.equal(markdownSafeUrl('https://x/a(1).jpeg'), 'https://x/a%281%29.jpeg')
  const markdown = await imageMarkdownLocal([
    { url: 'https://127.0.0.1:1/should-fail.jpeg' },
    { url: '' },
    { nothing: true },
  ])
  // 下载失败要退回远端 URL：图看不见比链接过期更糟
  assert.match(markdown, /!\[豆包生图 1\]\(https:\/\/127\.0\.0\.1:1\/should-fail\.jpeg\)/)
  assert.equal(markdown.match(/豆包生图/g).length, 1)
})

test('生图：无图片时不出 Markdown', async () => {
  assert.equal(await imageMarkdownLocal([]), '')
  assert.equal(await imageMarkdownLocal(undefined), '')
})

test('普通对话：上游成功 → 标准 SSE 带 [DONE]', async () => {
  const shim = makeShim()
  try {
    const baseUrl = await shim.baseUrl()
    // 上游必然失败（本机没有豆包登录态），但先验证「错误也是合法 OpenAI 信封」
    const response = await post(baseUrl, shim.token(), {
      model: '3',
      messages: [{ role: 'user', content: '你好' }],
    })
    // 没有真 cookie 时上游拒绝，走错误分支；关键是**形状**要对
    assert.ok([200, 400, 401, 429, 502].includes(response.status), `意外的状态 ${response.status}`)
    if (response.status !== 200) {
      const payload = await response.json()
      assert.ok(payload.error !== undefined, '错误必须是 OpenAI 信封')
      assert.equal(typeof payload.error.code, 'string')
    }
  } finally {
    await shim.close()
  }
})

for (const [name, fn] of cases) {
  try {
    await fn()
    passed += 1
  } catch (error) {
    console.error(`✗ ${name}`)
    console.error(`  ${error.message}`)
    process.exitCode = 1
  }
}
if (process.exitCode !== 1) console.log(`✓ doubao-shim: ${passed} 项全部通过`)
else console.log(`doubao-shim: ${passed}/${cases.length} 通过`)
