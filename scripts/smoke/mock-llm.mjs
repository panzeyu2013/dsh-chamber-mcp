// Mock OpenAI-compatible chat completions server (SSE) capturing request bodies.
// Records each request to .smoke/logs/llm-requests.jsonl (repo-relative, cwd-independent).
import { createServer } from 'node:http'
import { appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PORT = Number(process.argv[2] ?? 39001)
const LOG = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.smoke', 'logs', 'llm-requests.jsonl')

const server = createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/models' || req.url.startsWith('/models'))) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'deepseek-v4-flash', object: 'model' }] }))
    return
  }
  if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
    res.writeHead(404).end('not found')
    return
  }
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    let parsed = null
    try { parsed = JSON.parse(body) } catch { parsed = { raw: body.slice(0, 500) } }
    const record = {
      ts: Date.now(),
      url: req.url,
      model: parsed?.model,
      tools: (parsed?.tools ?? []).map((t) => t?.function?.name ?? t?.name),
      toolCount: (parsed?.tools ?? []).length,
      hasToolsField: Array.isArray(parsed?.tools),
      messages: (parsed?.messages ?? []).length,
    }
    try { appendFileSync(LOG, JSON.stringify(record) + '\n') } catch { /* best effort */ }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    const chunk = (part, finish = false, usage = false) => {
      const payload = {
        id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
        model: parsed?.model ?? 'mock',
        choices: [{ index: 0, delta: part, finish_reason: finish ? 'stop' : null }],
      }
      if (usage) payload.usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      res.write(`data: ${JSON.stringify(payload)}\n\n`)
    }
    res.write(`data: ${JSON.stringify({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: parsed?.model ?? 'mock', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`)
    chunk({ content: 'pong' })
    chunk({}, true, true)
    res.end('data: [DONE]\n\n')
  })
})

server.listen(PORT, '127.0.0.1', () => console.log(`mock-llm listening on ${PORT}`))
