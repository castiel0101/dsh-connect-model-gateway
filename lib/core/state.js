/**
 * 插件状态落盘。
 *
 * 每个平台一个文件：`~/.dsh/model-pool/<platform>.json`
 * 结构固定为：
 * ```json
 * {
 *   "activeAccount": "id",
 *   "accounts": [{ "id": "...", "label": "...", "credential": {...}, "addedAt": 0 }],
 *   "disabledModels": ["id"],
 *   "checkIn": { "date": "2026-11-24", "credit": 0 }
 * }
 * ```
 *
 * 写入用临时文件 + rename，避免半个文件。
 *
 * @module dsh-connect-model-gateway/core/state
 */

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

/** 读一份状态；文件不存在或损坏都返回默认骨架。 */
export async function readState(path) {
  let raw
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return emptyState()
  }
  try {
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return emptyState()
    /**
     * 踩过的坑：这里以前只挑 4 个字段返回，把 `checkInByAccount` /
     * `modelSettings` / `modelMeta` / `options` 全丢了 —— 读盘一次就没了，
     * 下次 save 再写回去时这些字段已经不存在。表现是「重启后签到记录清零、
     * 模型上下文/图片覆盖失效、平台开关复位」。
     *
     * 现在改成：**以磁盘内容为基底**，只对已知字段做类型归一，未知字段原样保留
     * （前进兼容：新版本加的字段不会被旧版本读一次就抹掉）。
     */
    const state = { ...parsed }
    state.activeAccount = typeof parsed.activeAccount === 'string' ? parsed.activeAccount : ''
    state.accounts = Array.isArray(parsed.accounts) ? parsed.accounts.filter((a) => a && typeof a.id === 'string') : []
    state.disabledModels = Array.isArray(parsed.disabledModels)
      ? parsed.disabledModels.filter((id) => typeof id === 'string')
      : []
    state.checkIn = parsed.checkIn !== null && typeof parsed.checkIn === 'object' ? parsed.checkIn : {}
    state.checkInByAccount = parsed.checkInByAccount !== null && typeof parsed.checkInByAccount === 'object' ? parsed.checkInByAccount : {}
    state.modelSettings = parsed.modelSettings !== null && typeof parsed.modelSettings === 'object' ? parsed.modelSettings : {}
    state.modelMeta = parsed.modelMeta !== null && typeof parsed.modelMeta === 'object' ? parsed.modelMeta : {}
    state.options = parsed.options !== null && typeof parsed.options === 'object' ? parsed.options : {}
    return state
  } catch {
    return emptyState()
  }
}

export function emptyState() {
  return {
    activeAccount: '',
    accounts: [],
    disabledModels: [],
    checkIn: {},
    checkInByAccount: {},
    modelSettings: {},
    modelMeta: {},
    options: {},
  }
}

/** 原子写一份状态。 */
export async function writeState(path, state) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}`
  await writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600 })
  await rename(temporary, path)
}

/** 取当前生效账号：显式选中的，否则第一个。 */
export function activeOf(state) {
  if (state.accounts.length === 0) return undefined
  const found = state.accounts.find((account) => account.id === state.activeAccount)
  return found ?? state.accounts[0]
}
