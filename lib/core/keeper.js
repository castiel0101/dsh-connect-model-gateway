/**
 * CodeArts 保活进程的启停。
 *
 * 用独立子进程而不是主进程定时器：宿主忙或窗口关掉时主进程定时器会被拖慢，
 * 而 refresh_token 到期没续上就掉登录。
 *
 * @module dsh-connect-model-gateway/core/keeper
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('./keeper-main.js', import.meta.url))

/**
 * 启动保活。
 *
 * @param {{accountsPath: string, intervalMs?: number, warn?: (m: string) => void}} options
 * @returns {{stop: () => void}}
 */
export function startKeeper(options) {
  const warn = options.warn ?? (() => {})
  let child

  const launch = () => {
    try {
      child = spawn(process.execPath, [SCRIPT, options.accountsPath, String(options.intervalMs ?? 15 * 60_000)], {
        // Electron 二进制要靠这个变量当 node 用
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        detached: false,
        stdio: 'ignore',
      })
      child.on('error', (error) => warn(`CodeArts 保活进程启动失败：${String(error)}`))
      child.on('exit', (code) => {
        if (code !== 0) warn(`CodeArts 保活进程退出（code ${code}），10 秒后重启`)
        // 异常退出自动拉起来；主动 stop 时 child 已被清空
        if (child !== undefined) {
          const timer = setTimeout(() => {
            if (child !== undefined) launch()
          }, 10_000)
          timer.unref?.()
        }
      })
      child.unref?.()
    } catch (error) {
      warn(`CodeArts 保活进程启动异常：${String(error)}`)
    }
  }

  launch()

  return {
    stop: () => {
      const current = child
      child = undefined
      try {
        current?.kill()
      } catch {
        // 退出阶段杀不掉就算了
      }
    },
  }
}
