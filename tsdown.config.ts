/**
 * tsdown 构建（dsh-dingo）：浏览器 client 单包 `lib/client.js`
 * （CJS closure factory，按 package-name id `dsh-dingo` 注册）。
 *
 * host 半由 `tsc -p tsconfig.json` 构建（lib/index.js 保持 @deepseek-ai/*
 * 外部引用，由 profile 安装处解析）；本配置只构建 client 半。
 *
 * 镜像 dsh-localvoice 的 client-bundle 预设：
 * - externals 走冻结的 loader 模块表（react、cordis、@deepseek-ai/dsh-client-* 平台模块）；
 * - 其余全部内联进 bundle；
 * - purity gate 拒绝任何其它 @deepseek-ai 值导入（type-only 导入被擦除，不达此门）。
 */
import type { UserConfig } from 'tsdown'

const PLUGIN_ID = 'dsh-dingo'

const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-client-connection/client',
  '@deepseek-ai/dsh-client-runtime/client',
  '@deepseek-ai/dsh-client-ui-slots',
] as const

export default {
  name: `${PLUGIN_ID}/client`,
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    neverBundle: [...CLIENT_EXTERNALS],
    alwaysBundle: (id: string) => (CLIENT_EXTERNALS.includes(id as (typeof CLIENT_EXTERNALS)[number]) ? undefined : true),
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  plugins: [{
    // Bundle purity gate：平台种子条目保持 external；其它 @deepseek-ai 值导入
    // 一律构建错误（type-only 导入被擦除，不达此门）。
    name: 'dsh-client-bundle-purity',
    resolveId(source: string) {
      if (!source.startsWith('@deepseek-ai/')) return null
      if (CLIENT_EXTERNALS.includes(source as (typeof CLIENT_EXTERNALS)[number])) return null
      throw new Error(
        `client bundle purity: "${source}" is not a platform module (CLIENT_EXTERNALS) — `
        + 'cross-plugin value imports are forbidden; collaborate through cordis services (type-only imports are erased and never reach this gate)',
      )
    },
  }],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    codeSplitting: false,
  },
} satisfies UserConfig
