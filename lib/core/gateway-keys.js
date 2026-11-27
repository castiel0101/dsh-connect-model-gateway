/**
 * 魔桥 OpenAI 网关 · API Key 存储与审计（TK-0003）。
 *
 * 为什么单独一个文件：Key 的生成/校验/审计是「安全边界」，与 HTTP 通道、
 * 协议翻译都不该混在一起；网关只 import 三个函数（authenticate / rateLimiter /
 * appendAudit），单测也能脱离 server 直接测。
 *
 * 四条硬约束（后续工单不要放松）：
 * 1. **绝不落明文**：`gateway.json` 里只有 `sha256(明文)` 的 hash、prefix/suffix。
 *    明文只在 `createKey()` 的返回值里出现一次。
 * 2. **恒时比较**：`verifyKey` 走 `crypto.timingSafeEqual`，长度不等也不提前
 *    return（先补零到同长再比），避免按耗时推断「前缀命中了几个字节」。
 * 3. **审计只写白名单字段**：`{at, keyId, keySuffix, model, account,
 *    promptTokens, completionTokens, status}`。messages 正文、请求体、完整 Key
 *    一律不进审计文件。
 * 4. **文件容错**：不存在 → 空结构；JSON 损坏 → warn 后重建（不让网关起不来）。
 *
 * 存储布局（与 auto.json 同级）：
 * `~/.dsh/model-pool/gateway.json`、`~/.dsh/model-pool/gateway-audit.ndjson`，
 * 目录 0700、文件 0600。
 *
 * @module dsh-connect-model-gateway/core/gateway-keys
 */

import { appendFile, chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Key 明文前缀（前缀本身不是秘密，用于日志/界面一眼看出是网关 Key）。 */
export const KEY_PREFIX = 'mgw_live_'

/** 默认状态目录（与插件其它状态文件一致）。 */
export function defaultStateDir() {
  return join(homedir(), '.dsh', 'model-pool')
}

/** 默认 Key 存储路径。 */
export function defaultKeysPath() {
  return join(defaultStateDir(), 'gateway.json')
}

/** 默认审计日志路径。 */
export function defaultAuditPath() {
  return join(defaultStateDir(), 'gateway-audit.ndjson')
}

/** 审计字段白名单：多写一个字段都算泄漏风险，所以显式列出而不是 spread。 */
const AUDIT_FIELDS = [
  'at',
  'keyId',
  'keySuffix',
  'model',
  'account',
  'promptTokens',
  'completionTokens',
  'status',
]

/** 空存储结构。 */
function emptyState() {
  return { keys: [], aliases: {}, options: {} }
}

/** 目录权限：只给自己。 */
const DIR_MODE = 0o700

/** 文件权限：只给自己（fs.chmod 显式再设一遍，umask 不可信）。 */
const FILE_MODE = 0o600

/** sha256(明文) 的字节长度。 */
const HASH_BYTES = 32

/** 审计字段的字符串上限：审计是「一行一条」，不能被超长模型名撑爆。 */
const AUDIT_TEXT_MAX = 160

/** 明文随机部分的字符数（`mgw_live_` 之后）。 */
const SECRET_CHARS = 32

/**
 * sha256 → hex。
 *
 * @param {string} text
 * @returns {string}
 */
function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** sha256 → 32 字节 Buffer（只算一次，避免每个候选再哈希）。 */
function sha256Buffer(text) {
  return createHash('sha256').update(text, 'utf8').digest()
}

/**
 * 恒时字符串比较。
 *
 * 两条路径都必须走完 `timingSafeEqual`：`timingSafeEqual` 在长度不等时会**抛错**，
 * 那不是我们想要的「比较失败」，也会让调用方从异常里看出长度信息。所以先把两边
 * 补零到同长，再比较，最后才把「原始长度是否相等」并进结果。
 *
 * @param {Buffer} left
 * @param {Buffer} right
 * @returns {boolean}
 */
function timingSafeEqualPadded(left, right) {
  const length = Math.max(left.length, right.length)
  const a = Buffer.alloc(length)
  const b = Buffer.alloc(length)
  left.copy(a, 0)
  right.copy(b, 0)
  const equal = timingSafeEqual(a, b)
  return equal && left.length === right.length
}

/**
 * hex → 固定 32 字节 Buffer。损坏/被手改的 hash 不抛错，补零后照样走比较。
 *
 * @param {unknown} hex
 * @returns {Buffer}
 */
function hashBufferOf(hex) {
  const buffer = Buffer.alloc(HASH_BYTES)
  if (typeof hex !== 'string' || hex.length === 0) return buffer
  const parsed = Buffer.from(hex.slice(0, HASH_BYTES * 2), 'hex')
  parsed.copy(buffer, 0, 0, Math.min(parsed.length, HASH_BYTES))
  return buffer
}

/** 生成 32 位随机串（base64url 字符集，无 `+/=`，方便粘进各种客户端）。 */
function randomSecret() {
  // 24 字节 base64url 恰好 32 个字符（每 3 字节 4 字符），且无填充
  return randomBytes((SECRET_CHARS / 4) * 3).toString('base64url')
}

/** 归一化一条 Key 记录：只保留已知字段，坏数据不往下传。 */
function normalizeRecord(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  const id = typeof raw.id === 'string' && raw.id !== '' ? raw.id : `k_${randomUUID()}`
  const hash = typeof raw.hash === 'string' ? raw.hash : ''
  if (hash === '') return undefined
  return {
    id,
    name: typeof raw.name === 'string' ? raw.name : '',
    hash,
    prefix: typeof raw.prefix === 'string' ? raw.prefix : '',
    suffix: typeof raw.suffix === 'string' ? raw.suffix : '',
    enabled: raw.enabled !== false,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date(0).toISOString(),
    lastUsedAt: typeof raw.lastUsedAt === 'string' ? raw.lastUsedAt : null,
    disabledAt: typeof raw.disabledAt === 'string' ? raw.disabledAt : null,
  }
}

/** 对外视图：**不含 hash**，也不可能含明文。 */
function publicRecord(record) {
  return {
    id: record.id,
    name: record.name,
    prefix: record.prefix,
    suffix: record.suffix,
    enabled: record.enabled,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    disabledAt: record.disabledAt,
  }
}

/** 审计字段：去控制字符、截断、非字符串一律变空串。 */
function auditText(value, max = AUDIT_TEXT_MAX) {
  if (typeof value !== 'string' || value === '') return ''
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned
}

/** 审计 token 数：只接受有限非负数。 */
function auditCount(value) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0
}

/**
 * 创建 Key 存储门面。
 *
 * 构造阶段**不做 I/O**：网关可以先建好门面，第一个请求/第一次 createKey 才碰盘。
 *
 * @param {object} [options]
 * @param {string} [options.keysPath] Key 存储路径，默认 `~/.dsh/model-pool/gateway.json`
 * @param {string} [options.auditPath] 审计路径，默认同级 `gateway-audit.ndjson`
 * @param {(message: string) => void} [options.warn] 告警（损坏/重建/权限失败）
 * @returns {object} 门面（见各方法注释）
 */
export function createKeyStore(options = {}) {
  const keysPath = typeof options.keysPath === 'string' && options.keysPath !== ''
    ? options.keysPath
    : defaultKeysPath()
  const auditPath = typeof options.auditPath === 'string' && options.auditPath !== ''
    ? options.auditPath
    : join(dirname(keysPath), 'gateway-audit.ndjson')
  const warn = typeof options.warn === 'function' ? options.warn : () => {}

  /** 串行化写盘：并发 createKey/verifyKey 不会互相覆盖。 */
  let writeChain = Promise.resolve()

  /** 建目录（0700）+ 逐级校验权限。已存在时不改属主，只补 mode。 */
  async function ensureDir(path) {
    const dir = dirname(path)
    await mkdir(dir, { recursive: true, mode: DIR_MODE })
    try {
      await chmod(dir, DIR_MODE)
    } catch (error) {
      warn(`网关状态目录权限设置失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * 读存储。ENOENT → 空结构；其它错误（含 JSON 损坏）→ warn + 重建。
   *
   * @returns {Promise<{keys: object[], aliases: object, options: object, rebuilt?: boolean}>}
   */
  async function readState() {
    let text
    try {
      text = await readFile(keysPath, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        warn(`读取网关 Key 存储失败（按空存储处理）：${error instanceof Error ? error.message : String(error)}`)
      }
      return emptyState()
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      warn(`网关 Key 存储 JSON 损坏，已重建：${keysPath}`)
      return { ...emptyState(), rebuilt: true }
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      warn(`网关 Key 存储结构非法，已重建：${keysPath}`)
      return { ...emptyState(), rebuilt: true }
    }
    const keys = Array.isArray(parsed.keys)
      ? parsed.keys.map(normalizeRecord).filter((record) => record !== undefined)
      : []
    return {
      keys,
      aliases: parsed.aliases !== null && typeof parsed.aliases === 'object' && !Array.isArray(parsed.aliases)
        ? parsed.aliases
        : {},
      options: parsed.options !== null && typeof parsed.options === 'object' && !Array.isArray(parsed.options)
        ? parsed.options
        : {},
      rebuilt: Array.isArray(parsed.keys) ? false : true,
    }
  }

  /** 原子写：先写临时文件再 rename，半截文件不会被读成「全部 Key 丢失」。 */
  async function writeState(state) {
    await ensureDir(keysPath)
    const payload = {
      version: 1,
      keys: state.keys,
      aliases: state.aliases,
      options: state.options,
    }
    const text = `${JSON.stringify(payload, null, 2)}\n`
    const temp = `${keysPath}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temp, text, { mode: FILE_MODE })
    try {
      await chmod(temp, FILE_MODE)
      await rename(temp, keysPath)
      await chmod(keysPath, FILE_MODE)
    } catch (error) {
      await unlink(temp).catch(() => {})
      throw error
    }
  }

  /**
   * 排队执行的「读 → 改 → 写」。
   *
   * 必须串行：两个并发请求各自 readState 后写回，后写的会把先写的覆盖掉
   * （典型症状是 lastUsedAt 丢、新建的 Key 消失）。所以整段事务排在 writeChain 上。
   *
   * @template T
   * @param {(state: object) => T|Promise<T>} mutator 就地修改 state；返回值透传
   * @returns {Promise<T>}
   */
  function mutate(mutator) {
    const run = writeChain.then(async () => {
      const state = await readState()
      const result = await mutator(state)
      try {
        await writeState(state)
      } catch (error) {
        warn(`保存网关 Key 存储失败：${error instanceof Error ? error.message : String(error)}`)
      }
      return result
    })
    // 事务失败不能把后续事务一起毒死：链上只保留「已完成」状态
    writeChain = run.then(() => {}, () => {})
    return run
  }

  return {
    keysPath,
    auditPath,

    /**
     * 新建一把 Key。
     *
     * 明文只在返回值里出现这一次；落盘只有 hash + prefix/suffix。
     *
     * @param {string} [name] 人类可读名称（界面展示用，不影响鉴权）
     * @returns {Promise<{id: string, name: string, key: string}>}
     */
    async createKey(name = '') {
      const secret = randomSecret()
      const key = `${KEY_PREFIX}${secret}`
      const record = {
        id: `k_${randomUUID()}`,
        name: auditText(name, 80),
        // 只存 sha256(明文)：文件泄漏也推不回明文
        hash: sha256Hex(key),
        // `mgw_live_` 是常量，拿来当前缀没有识别价值；取随机段前 4 位。
        prefix: secret.slice(0, 4),
        suffix: secret.slice(-4),
        enabled: true,
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
        disabledAt: null,
      }
      await mutate((state) => {
        state.keys.push(record)
      })
      return { id: record.id, name: record.name, key }
    },

    /**
     * 校验明文 Key：命中且 enabled 才返回记录（不含 hash）。
     *
     * 恒时：所有候选都走一次 `timingSafeEqual`，命中位置不影响耗时。
     *
     * @param {unknown} plaintext
     * @returns {Promise<object|undefined>}
     */
    async verifyKey(plaintext) {
      if (typeof plaintext !== 'string' || plaintext === '') return undefined
      const digest = sha256Buffer(plaintext)
      return mutate((state) => {
        /** @type {object|undefined} */
        let hit
        for (const record of state.keys) {
          const equal = timingSafeEqualPadded(digest, hashBufferOf(record.hash))
          // 故意不 break：比较次数固定，避免从耗时推断「命中的是第几把」
          if (equal && hit === undefined) hit = record
        }
        if (hit === undefined || hit.enabled !== true) return undefined
        hit.lastUsedAt = new Date().toISOString()
        return publicRecord(hit)
      })
    },

    /**
     * 列出 Key（不含 hash、不含明文）。
     *
     * @returns {Promise<object[]>}
     */
    async listKeys() {
      const state = await readState()
      return state.keys.map(publicRecord)
    },

    /**
     * 启用/禁用一把 Key。
     *
     * @param {string} id
     * @param {boolean} [enabled]
     * @returns {Promise<object|undefined>} 更新后的记录（未命中 undefined）
     */
    async setEnabled(id, enabled = true) {
      return mutate((state) => {
        const record = state.keys.find((item) => item.id === id)
        if (record === undefined) return undefined
        record.enabled = enabled !== false
        record.disabledAt = record.enabled ? null : new Date().toISOString()
        return publicRecord(record)
      })
    },

    /**
     * 删除一把 Key（硬删，审计里已写入的历史记录保留）。
     *
     * @param {string} id
     * @returns {Promise<boolean>} 是否真的删掉了
     */
    async removeKey(id) {
      return mutate((state) => {
        const before = state.keys.length
        state.keys = state.keys.filter((item) => item.id !== id)
        return state.keys.length !== before
      })
    },

    /**
     * 追加一条审计。**字段白名单之外的一律丢弃**，所以传整条请求体也不会漏。
     *
     * @param {object} record
     * @returns {Promise<void>}
     */
    async appendAudit(record) {
      const source = record !== null && typeof record === 'object' ? record : {}
      const entry = {
        at: typeof source.at === 'string' && source.at !== '' ? source.at : new Date().toISOString(),
        keyId: auditText(source.keyId, 80),
        keySuffix: auditText(source.keySuffix, 8),
        model: auditText(source.model),
        account: auditText(source.account),
        promptTokens: auditCount(source.promptTokens),
        completionTokens: auditCount(source.completionTokens),
        status: typeof source.status === 'number' && Number.isFinite(source.status)
          ? Math.floor(source.status)
          : auditText(source.status, 32),
      }
      // 显式守卫：白名单字段一个都不许少、多一个都不许有
      const line = `${JSON.stringify(
        Object.fromEntries(AUDIT_FIELDS.map((field) => [field, entry[field]])),
      )}\n`
      await ensureDir(auditPath)
      await appendFile(auditPath, line, { mode: FILE_MODE })
      try {
        await chmod(auditPath, FILE_MODE)
      } catch (error) {
        warn(`审计文件权限设置失败：${error instanceof Error ? error.message : String(error)}`)
      }
    },
  }
}

/** 审计字段名（测试与装配方用来核对白名单）。 */
export { AUDIT_FIELDS }
