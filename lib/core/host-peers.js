/**
 * 宿主包解析。
 *
 * 背景：插件里写 `import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'`
 * 这种顶层静态导入，在 Desktop 里会失败 —— 插件装在 profile 或外部链接目录，
 * 而宿主包只在 app.asar 内。所以改成运行期解析：
 *
 * 1. 先试裸标识符（npm 安装、依赖完整、或宿主做了别名时都走这条）；
 * 2. 再试 asar 内的绝对文件 URL（Desktop 的正常情况）；
 * 3. 最后试 `DSH_INSTALL_DIR` 的 node_modules（非打包安装）。
 *
 * 只在 apply() 里 await 一次，插件加载不被阻塞太久。
 *
 * @module dsh-connect-model-gateway/core/host-peers
 */

/** 候选 node_modules 根目录，按优先级。 */
function candidateRoots() {
  const roots = []
  // Desktop：<resources>/app.asar/dsh/node_modules
  if (typeof process.resourcesPath === 'string' && process.resourcesPath !== '') {
    roots.push(`${process.resourcesPath}/app.asar/dsh/node_modules`)
  }
  // 非打包安装：DSH_INSTALL_DIR 是 @deepseek-ai/dsh 包目录
  const installDir = process.env.DSH_INSTALL_DIR
  if (typeof installDir === 'string' && installDir !== '') {
    roots.push(`${installDir}/node_modules`)
    roots.push(`${installDir}/../../node_modules`)
  }
  return roots
}

/** 每个包已知的入口文件：specifier → { pkg, file }。 */
const ENTRIES = {
  '@deepseek-ai/dsh-llm-pi-ai': { pkg: '@deepseek-ai/dsh-llm-pi-ai', file: 'lib/index.js' },
  '@deepseek-ai/dsh-llm': { pkg: '@deepseek-ai/dsh-llm', file: 'lib/index.js' },
  '@earendil-works/pi-ai': { pkg: '@earendil-works/pi-ai', file: 'dist/index.js' },
  '@earendil-works/pi-ai/api/openai-completions.lazy': {
    pkg: '@earendil-works/pi-ai',
    file: 'dist/api/openai-completions.lazy.js',
  },
}

/** 试一个 URL 是否可导入。 */
async function tryImport(url) {
  try {
    return await import(url)
  } catch {
    return undefined
  }
}

/**
 * 解析一个宿主包。
 *
 * @param {string} specifier 包名或子路径键（必须在 ENTRIES 里）
 * @returns {Promise<any>}
 */
export async function loadHostPackage(specifier) {
  // 1) 裸标识符
  const direct = await tryImport(specifier)
  if (direct !== undefined) return direct

  // 2) asar / 安装目录下的绝对路径
  const entry = ENTRIES[specifier]
  if (entry === undefined) throw new Error(`dsh-connect-model-gateway: 不知道 ${specifier} 的入口，无法回退解析`)
  for (const root of candidateRoots()) {
    const url = `file://${root}/${entry.pkg}/${entry.file}`
    const loaded = await tryImport(url)
    if (loaded !== undefined) return loaded
  }

  throw new Error(
    `dsh-connect-model-gateway: 无法解析宿主包 ${specifier}。已尝试裸导入与 ${candidateRoots().join(', ') || '(无候选根)'}`,
  )
}

/** 一次把所有需要的宿主包取回来。 */
export async function loadHostPeers() {
  const [piAi, llm, completions] = await Promise.all([
    loadHostPackage('@deepseek-ai/dsh-llm-pi-ai'),
    loadHostPackage('@deepseek-ai/dsh-llm'),
    loadHostPackage('@earendil-works/pi-ai'),
  ])
  const lazy = await loadHostPackage('@earendil-works/pi-ai/api/openai-completions.lazy')
  return {
    PiAiAdapter: piAi.PiAiAdapter,
    resolveRetryPolicy: llm.resolveRetryPolicy,
    // TK-0002：非流式 chat/completions 用宿主的规范聚合器，避免自造聚合逻辑
    BlockAssembler: llm.BlockAssembler,
    createProvider: piAi.createProvider ?? completions.createProvider,
    openAICompletionsApi: lazy.openAICompletionsApi,
  }
}
