/**
 * 重试友好 fetch 自测：SSE 截断必须变成「流错误」而不是干净 EOF。
 *
 * 跑法：node test/retry-fetch.test.mjs
 *
 * 背景：`withInterruptionAwareBody` 以前在 EOF 时无条件 `controller.close()`。
 * 上游把连接一关（没有 finish_reason、没有 `[DONE]`）时，下游拿到的是干净结束，
 * pi-ai 只会报 `Stream ended without finish_reason`，宿主 `classifyPiAiError`
 * 把它归成 `PI_AI_ERROR`（不可重试），于是一次抖动 = 整轮失败。
 * 改成 `controller.error()` 后错误文案能命中宿主的 TRANSPORT 关键词
 * （`connection` / `stream ended before`），`llm-retry` 才会自动退避重试。
 */

import assert from 'node:assert/strict'
import { withRetryFriendlyApi } from '../lib/core/retry-fetch.js'

let passed = 0
const failures = []

async function test(name, fn) {
  try {
    await fn()
    passed += 1
    process.stdout.write(`  ok   ${name}\n`)
  } catch (error) {
    failures.push({ name, error })
    process.stdout.write(`  FAIL ${name}\n         ${error.message}\n`)
  }
}

/** 把若干 SSE 文本块拼成一个响应体（先全部 enqueue，再 close）。 */
function sseResponse(frames, status = 200) {
  const body = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder()
      for (const frame of frames) controller.enqueue(encoder.encode(frame))
      controller.close()
    },
  })
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } })
}

/**
 * 取出 `withRetryFriendlyApi` 注入给 pi-ai 的那个 fetch。
 *
 * 包装只通过 `options.fetch` 下发，没有直接导出，所以用假 api 截获它。
 */
function injectedFetch(responseFactory) {
  let injected
  const api = withRetryFriendlyApi({
    stream: (_model, _context, options) => {
      injected = options.fetch
    },
  }, { fetchImpl: responseFactory })
  api.stream({}, { messages: [] }, {})
  return injected
}

/** 消费整个流，返回 { text, error }。 */
async function drain(response) {
  const decoder = new TextDecoder()
  let text = ''
  try {
    for await (const chunk of response.body) text += decoder.decode(chunk, { stream: true })
    return { text, error: null }
  } catch (error) {
    return { text, error }
  }
}

const contentFrame = 'data: {"choices":[{"delta":{"content":"半截"}}]}\n\n'
const stopFrame = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
const doneFrame = 'data: [DONE]\n\n'

await test('截断（无 finish_reason 也无 [DONE]）→ 流以错误结束，不是干净 EOF', async () => {
  const fetchImpl = injectedFetch(() => sseResponse([contentFrame]))
  const response = await fetchImpl('http://127.0.0.1:1/v1/chat/completions', { method: 'POST', body: '{}' })
  const { error } = await drain(response)
  assert.ok(error, '截断必须抛错，否则宿主不会重试')
  // 文案要能同时命中宿主的 TRANSPORT 关键词，否则仍会被判成不可重试
  assert.match(error.message, /connection/i)
  assert.match(error.message, /stream ended before/i)
})

await test('有 finish_reason 的流正常收尾，不抛错', async () => {
  const fetchImpl = injectedFetch(() => sseResponse([contentFrame, stopFrame]))
  const response = await fetchImpl('http://127.0.0.1:1/v1/chat/completions', { method: 'POST', body: '{}' })
  const { error, text } = await drain(response)
  assert.equal(error, null)
  assert.equal(text, contentFrame + stopFrame)
})

await test('有 [DONE] 的流正常收尾，不抛错', async () => {
  const fetchImpl = injectedFetch(() => sseResponse([contentFrame, doneFrame]))
  const response = await fetchImpl('http://127.0.0.1:1/v1/chat/completions', { method: 'POST', body: '{}' })
  const { error } = await drain(response)
  assert.equal(error, null)
})

await test('一帧都没有的空流 → 也算截断', async () => {
  const fetchImpl = injectedFetch(() => sseResponse([]))
  const response = await fetchImpl('http://127.0.0.1:1/v1/chat/completions', { method: 'POST', body: '{}' })
  const { error } = await drain(response)
  assert.ok(error, '空流同样不能当正常结束')
})

await test('非 SSE 响应原样透传（不包装、不判截断）', async () => {
  const fetchImpl = injectedFetch(() => new Response('{"ok":true}', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }))
  const response = await fetchImpl('http://127.0.0.1:1/v1/chat/completions', { method: 'POST', body: '{}' })
  assert.equal(await response.text(), '{"ok":true}')
})

process.stdout.write(`\nretry-fetch: ${passed} 项通过，${failures.length} 项失败\n`)
if (failures.length > 0) {
  for (const { name, error } of failures) {
    process.stderr.write(`\n✗ ${name}\n${error.stack ?? error.message}\n`)
  }
  process.exitCode = 1
}
