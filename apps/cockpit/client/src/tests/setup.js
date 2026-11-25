import '@testing-library/jest-dom'
import { File as NodeFile } from 'node:buffer'
import { server } from './mocks/server.js'

// Node 25+ ships its own Web Storage globals (`localStorage` / `sessionStorage`
// accessors on globalThis), which are unusable without `--localstorage-file`.
// Vitest's jsdom environment only copies a window property onto the global when
// Node doesn't already define it (or it's on Vitest's fixed key list, which
// `Storage` is but these two aren't), so jsdom's working storage is skipped and
// tests see Node's. Point both back at jsdom. On Node <25 this re-points them
// at the same jsdom objects, so it's a no-op there.
for (const key of ['localStorage', 'sessionStorage']) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    enumerable: true,
    get: () => jsdom.window[key],
  })
}

// Multipart uploads. Node 25+'s bundled fetch (undici) looks up the *global* `File`
// whenever it creates a file entry, both in `FormData.append(blob)` and when
// parsing a multipart body in `body.formData()`, but it checks entries against
// the native `File` it captured at startup. Vitest's jsdom environment replaces
// the global `File` with jsdom's, so any multipart request fails with
// "webidl.is.File(value)". Node <25 builds these entries differently and is
// unaffected. Give Node's fetch layer its own `File` while it does that work.
function withNodeFile(fn) {
  const jsdomFile = globalThis.File
  globalThis.File = NodeFile
  const restore = () => {
    globalThis.File = jsdomFile
  }
  let result
  try {
    result = fn()
  } catch (err) {
    restore()
    throw err
  }
  if (typeof result?.then === 'function') return result.finally(restore)
  restore()
  return result
}

// Vitest's jsdom `Request` turns a jsdom FormData body into Node's FormData,
// appending each file as a Blob, so construct it with Node's File in scope.
const CompatRequest = globalThis.Request
globalThis.Request = class Request extends CompatRequest {
  constructor(...args) {
    withNodeFile(() => super(...args))
  }
}

// Parsing a multipart body (e.g. MSW handlers calling `request.formData()`).
// These are Node's own prototypes, which outlive a test file when a worker is
// reused, so wrap them only once.
const wrappedFormData = Symbol.for('mission-control.test.formDataWithNodeFile')
for (const Body of [Object.getPrototypeOf(CompatRequest), Response]) {
  const nativeFormData = Body.prototype.formData
  if (nativeFormData[wrappedFormData]) continue
  Body.prototype.formData = function formData() {
    return withNodeFile(() => nativeFormData.call(this))
  }
  Body.prototype.formData[wrappedFormData] = true
}

// MSW lifecycle
beforeAll(() => server.listen({ onUnhandledRequest: 'warn' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

// Stub EventSource global (jsdom has none)
class MockEventSource {
  constructor(url) {
    this.url = url
    this.listeners = {}
    this.onerror = null
    this.onopen = null
    this.closed = false
    MockEventSource.instance = this
    if (!MockEventSource.instances) MockEventSource.instances = []
    MockEventSource.instances.push(this)
  }
  addEventListener(type, handler) {
    if (!this.listeners[type]) this.listeners[type] = []
    this.listeners[type].push(handler)
  }
  removeEventListener(type, handler) {
    if (this.listeners[type]) {
      this.listeners[type] = this.listeners[type].filter((h) => h !== handler)
    }
  }
  close() {
    this.closed = true
  }
  // Helper for tests to emit events
  emit(type, data) {
    const handlers = this.listeners[type] || []
    handlers.forEach((h) => h({ data: JSON.stringify(data) }))
  }
}
global.EventSource = MockEventSource

// Stub clipboard
Object.defineProperty(navigator, 'clipboard', {
  value: { writeText: vi.fn().mockResolvedValue(undefined) },
  writable: true,
})

// jsdom doesn't implement scrollIntoView; several components call it in effects
// (e.g. LiveFeed autoscroll). Stub it globally so a full render doesn't throw.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = vi.fn()
}
